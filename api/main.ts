import 'reflect-metadata'
import { config as loadDotenv } from 'dotenv'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

const ROOT = join(__dirname, '..', '..')

/*
 * Files first, then the platform.
 *
 * Locally the values live in the same `.env` files the CLI tools read. On
 * Render there are no files and everything comes from the environment, so
 * `override: false` is what makes the platform win where both exist — that
 * is the value an operator set deliberately for this environment, against a
 * file that was probably left over from a deploy script.
 */
loadDotenv({ path: join(ROOT, 'contracts/.env'), override: false })
loadDotenv({ path: join(ROOT, '.env'), override: false })

// Imported after the environment is loaded: the config provider reads
// `process.env` at construction, and a module graph built first would see it
// empty.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('./app.module') as typeof import('./app.module')
const { CONFIG, configWarnings } = require('./config/configuration') as typeof import('./config/configuration')

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false })
  const config = app.get(CONFIG) as import('./config/configuration').AppConfig
  const logger = new Logger('bootstrap')

  for (const warning of configWarnings(config)) logger.warn(warning)

  /**
   * An allowlist, never `*`.
   *
   * The faucet spends money on request, and `*` invites every page on the
   * internet to spend it. A request with no Origin header at all — curl, a
   * health check, another server — is not a browser and is not subject to
   * CORS; it is allowed through and answered normally.
   */
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true)
      const normalised = origin.replace(/\/$/, '')
      const allowed =
        config.cors.origins.includes(normalised) || (config.cors.previewPattern?.test(normalised) ?? false)
      // `false` rather than an error: the browser is told no by the missing
      // header, and the log stays quiet about traffic that was never ours.
      callback(null, allowed)
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type'],
    maxAge: 86_400,
  })

  /*
   * Render sends SIGTERM on every deploy and every scale-down. Nest's
   * shutdown hooks are what stop the keeper's timer, so a redeploy does not
   * sit out a half-finished sweep before the platform gives up and kills it.
   */
  app.enableShutdownHooks()

  await app.listen(config.port, '0.0.0.0')
  logger.log(`listening on :${config.port} for chain ${config.chain.id} (${config.chain.network})`)
  logger.log(
    `CORS: ${config.cors.origins.join(', ')}${config.cors.previewPattern ? ' + project previews' : ''}`,
  )
}

void bootstrap()
