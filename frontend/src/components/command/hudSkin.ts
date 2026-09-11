/**
 * Visual of the console.
 *
 * Flip `COMMAND_HUD_SKIN` to restore the previous HUD in one place.
 *
 *   orbit    one floating command rail, fixed to the viewport
 *   classic  chamfered octagon on the globe
 */
export type CommandHudSkin = 'orbit' | 'classic'

export const COMMAND_HUD_SKIN: CommandHudSkin = 'orbit'

/**
 * What the reveal slot says, in its three states.
 *
 * One function because two controls render the same slot — the orbit rail's
 * primary action and the classic console's Defend button — and a round that
 * says "Decoding" in one skin and "Reveal" in the other is two answers to
 * one question about the same round.
 *
 * `auto` is the keeper carrying it with nobody having pressed anything;
 * `busy` is this page's own nudge in flight. Both are waits, but only the
 * second one was asked for, and the wording keeps them apart.
 */
export function revealLabel(auto: boolean, busy: boolean): string {
  if (auto) return 'Decoding'
  return busy ? 'Revealing' : 'Reveal'
}
