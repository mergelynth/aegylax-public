import { memo } from 'react'
import { CommandHudFrame } from './CommandHudFrame'
import { COMMAND_HUD_SKIN } from './hudSkin'

/**
 * Classic keeps the octagon SVG. The orbit skin is a viewport-fixed
 * command rail (`CommandRail`) — no second chassis over the copy.
 */
export const CommandHudChrome = memo(function CommandHudChrome({
  live = false,
  scanning = false,
}: {
  live?: boolean
  scanning?: boolean
}) {
  if (COMMAND_HUD_SKIN === 'classic') {
    return <CommandHudFrame live={live} scanning={scanning} />
  }
  return null
})
