import { Link } from 'react-router-dom'
import { appConfig } from '../../config/env'
import { NeonType } from '../../motion/NeonType'
import { LOGO_TYPE } from '../../motion/timeline'
import { useBootEntrance } from '../../motion/useBootEntrance'
import { GlobalStatsHud } from '../stats/GlobalStatsHud'
import { JackpotHud } from '../stats/JackpotHud'
import { ConnectWalletButton } from '../wallet/ConnectWalletButton'
import { ProtocolStatus } from './ProtocolStatus'
import styles from './Header.module.css'

/**
 * Light, single-row shell header (spec §5) — global stats (§6) live here,
 * not as a page-level card. Hierarchy left to right: brand -> protocol
 * status -> jackpot -> global defense status -> connect wallet. The
 * event-horizon countdown lives over Earth on the Home hero instead
 * (`SpaceHero`) — it's tied to the planet, not the chrome around it.
 */
export function Header() {
  const entering = useBootEntrance()

  return (
    /*
      ТЗ §3 — step one, and the one that sets the tone for the next two
      seconds: the bar opens horizontally like a command interface coming
      up, rather than fading in. See `app/motion.css`.
    */
    <header className={`${styles.header} boot-header`}>
      <div className={styles.brandGroup}>
        <Link to="/" viewTransition className={styles.brand}>
          {/*
            The wordmark is typed, letter by letter, each one arriving lit
            and cooling over about half a second.

            Not the hero title's scramble, and that is the point: the title
            decodes a value out of noise, this enters a name. Two different
            statements deserve two different mechanisms, and a page whose
            wordmark and headline perform the same trick has one idea
            repeated at two sizes. See `motion/NeonType`.
          */}
          <NeonType
            as="h1"
            className={styles.title}
            text={appConfig.appName}
            enabled={entering}
            delay={LOGO_TYPE.delay}
            step={LOGO_TYPE.step}
            duration={LOGO_TYPE.duration}
          />
          {/*
            And the subtitle waits for the name to finish typing — it is what
            the name *means*, so it has nothing to qualify until there is a
            name on screen. It lands together with the protocol shield beside
            it, so the whole brand corner resolves as one beat rather than as
            three separate arrivals. See "the brand signs itself" in
            `app/motion.css`.

            The class is applied only on a document load, which is what gates
            it — this group runs long after `[data-boot]` has come off.
          */}
          <span className={`${styles.subtitle}${entering ? ' sign-subtitle' : ''}`}>
            {appConfig.appSubtitle}
          </span>
        </Link>
        <div className={styles.statusCluster}>
          <ProtocolStatus />
          <JackpotHud />
        </div>
      </div>
      <div className={styles.stats}>
        <GlobalStatsHud />
      </div>
      {/* ТЗ §7 — the header's own wipe, mirrored: this end of the bar opens
          from its outer edge inward. */}
      <div className={`${styles.walletSlot} boot-wallet`}>
        <ConnectWalletButton />
      </div>
    </header>
  )
}
