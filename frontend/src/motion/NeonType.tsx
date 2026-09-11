import { prefersReducedMotion } from './prefersReducedMotion'
import styles from './NeonType.module.css'

export interface NeonTypeProps {
  text: string
  /** Whether this mount is a document load (`useBootEntrance`). */
  enabled: boolean
  /** ms before the first letter strikes. */
  delay?: number
  /** ms between one letter and the next. */
  step?: number
  /** ms a single letter spends igniting and cooling. */
  duration?: number
  className?: string
  as?: 'span' | 'h1'
}

/**
 * Letters struck one at a time, each arriving lit and cooling into place.
 *
 * Deliberately **not** the scramble the hero title uses. Both resolve text
 * out of nothing, but they say different things and they must not be
 * confused for one another: the title decodes — a value being recovered
 * from noise, all of it present at once and coming into focus — while this
 * types, one letter after the next, like a name being entered into a
 * terminal. A page whose wordmark and headline perform the same trick has
 * one idea repeated at two sizes.
 *
 * Each letter appears already glowing and the glow decays over roughly half
 * a second, so at any moment the newest letters are still hot and the older
 * ones have settled — the ignition travels along the word rather than
 * flashing it whole.
 *
 * The neon is a `text-shadow` and nothing else, which is what makes it work
 * on this particular host. The wordmark paints itself by clipping a
 * gradient to its own glyphs (`background-clip: text`, `color: transparent`
 * in `Header.module.css`), so animating `color` here would either fight
 * that or blank the letter; a shadow is painted from the glyph outline
 * regardless of how the glyph itself is filled. It also means this composes
 * with any host, gradient or not.
 *
 * `data-typing` is the other half of getting along with such a host, and it
 * is not cosmetic. `background-clip: text` clips the *host's* background to
 * the shape of all glyphs inside it, and that shape is computed from the
 * text geometry alone — a letter set to `opacity: 0` still contributes its
 * outline, so the host goes on painting it. The wordmark was therefore
 * fully legible from the first frame no matter what these letters did, and
 * the entrance amounted to a glow sweeping across a word that had never
 * been hidden. This attribute lets such a host turn its own fill off for
 * as long as the letters are painting themselves.
 *
 * No JavaScript runs. Each letter is one CSS animation with its own delay,
 * so the whole effect is a handful of elements fading on the compositor and
 * there is nothing to schedule, cancel or clean up.
 */
export function NeonType({
  text,
  enabled,
  delay = 0,
  step = 70,
  duration = 560,
  className,
  as = 'span',
}: NeonTypeProps) {
  const Tag = as

  // ТЗ — with motion off, and on any mount that is not a document load,
  // this is simply the word.
  if (!enabled || prefersReducedMotion()) return <Tag className={className}>{text}</Tag>

  return (
    /*
      One label on the element, and the letters hidden from assistive tech.
      Without this, a screen reader meeting seven separate one-character
      elements is liable to spell the brand out rather than say it.
    */
    <Tag className={className} aria-label={text} data-typing="">
      {[...text].map((character, index) => (
        <span
          key={`${character}-${index}`}
          className={styles.letter}
          aria-hidden="true"
          style={{ animationDelay: `${delay + index * step}ms`, animationDuration: `${duration}ms` }}
        >
          {character}
        </span>
      ))}
    </Tag>
  )
}
