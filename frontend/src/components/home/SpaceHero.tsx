import type { PointerEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  SEAL_CREDIT_SCRAMBLE,
  SEAL_STATE_SCRAMBLE,
  TITLE_CIPHER,
  TITLE_SCRAMBLE,
} from '../../motion/timeline'
import { CipherBlocks } from './CipherBlocks'
import { CipherTitle } from '../../motion/CipherTitle'
import { ScrambleText } from '../../motion/ScrambleText'
import { useBootEntrance } from '../../motion/useBootEntrance'
import { useUiStore } from '../../stores/uiStore'
import { splitProviderCredit, useProviderTheme } from '../../theme'
import { Button } from '../common/Button'
import { RollingLabel } from '../common/RollingLabel'
import styles from './SpaceHero.module.css'

/**
 * Puts the hovered link's trace under the pointer (see `.navTrace`).
 *
 * The trace is a short mark rather than an underline, and a short mark that
 * always sits at the head of the word is decoration: it is under "JOIN OP"
 * whichever end of the label you are pointing at. Moved to the cursor it
 * becomes an instrument — the label reads as a strip the system is scanning,
 * and the scan is wherever the pointer is.
 *
 * Written as a custom property rather than as React state on purpose. This
 * fires on every pointer move over two elements in a hero that also runs a
 * decoding headline; re-rendering the tree for it would put a component
 * render between the mouse and a 1px mark. A custom property goes straight
 * to style resolution and the position is a `transform`, so a move costs a
 * composite and nothing else.
 *
 * The offset is clamped to the label, and the length it is clamped by is
 * measured rather than restated — the trace's width is a percentage of the
 * word in the stylesheet, and a copy of that number here would be a second
 * source of truth that silently drifts. `offsetWidth` because it is layout
 * width: the element carries a `transform`, and a measured box would come
 * back already moved.
 */
function traceToPointer(event: PointerEvent<HTMLElement>) {
  const host = event.currentTarget
  const trace = host.querySelector<HTMLElement>('[data-trace]')
  if (!trace) return

  const box = host.getBoundingClientRect()
  host.style.setProperty(
    '--trace-x',
    `${traceOffset(event.clientX - box.left, box.width, trace.offsetWidth)}px`,
  )
}

/**
 * Where the mark's left edge goes, given where in the label the pointer is.
 *
 * Separated from the handler above because it is the only part of this that
 * can be wrong in a way nothing would notice: a browser draws a mark that is
 * half a length out, or that overhangs the word by a few pixels, perfectly
 * happily. `at` is the pointer's offset into the label, `width` the label,
 * `length` the mark.
 *
 * Centred on the pointer, then held inside the word — including the case
 * where there is no room to hold it in, which is not hypothetical: the mark
 * is a percentage of a label that is `clamp()`ed against the viewport, so a
 * narrow enough screen is a mark as wide as the word it is under.
 */
export function traceOffset(at: number, width: number, length: number): number {
  const room = Math.max(0, width - length)
  return Math.min(Math.max(at - length / 2, 0), room)
}

/**
 * ТЗ §2, §5 — three commands, staggered in the order they are meant to be
 * read.
 *
 * "Locate it. Time it. Intercept it." — the same three beats as before, in
 * the imperative and matched to the actual mechanics: you find where, you
 * find when, you commit. Shorter words also let the three phrases stagger
 * without the line running long enough to wrap on a narrow viewport.
 */
const TAGLINE = ['Locate it.', 'Time it.', 'Intercept it.']

/**
 * Atmospheric explanation of the game, overlaid directly on the space
 * scene — not a card/tutorial. Home page only; the Lobby page never
 * renders this component.
 *
 * ТЗ §31 — and the place where the motion system's central rule is most
 * visible: no two lines of this hero arrive the same way. The title
 * decodes, the subtitle unmasks, the tagline staggers by phrase, the CTA
 * opens from its own middle, the two ways in acquire a signal and open
 * outward from it, and the trajectory line performs a four-stage handshake.
 * What each of those *is* lives in `app/motion.css` and
 * `motion/timeline.ts`; this component only says which line is which step.
 */
export function SpaceHero() {
  const openCreateLobbyModal = useUiStore((state) => state.openCreateLobbyModal)
  const { theme, providerCredit } = useProviderTheme()
  const credit = providerCredit ? splitProviderCredit(providerCredit, theme.assets.providerName) : null
  /*
   * Asked once, at mount, and handed to every JavaScript-driven step below
   * (ТЗ §32). On a route change back to Home this is already false, so the
   * scrambles never run and each of these renders as plain text.
   */
  const entering = useBootEntrance()

  return (
    <div className={styles.hero}>
      {/*
        ТЗ §9 — the loudest motion on the page, and the only one that never
        finishes.

        It resolves out of technical noise from the middle of the string
        outward, holds five or six characters back as churning redaction
        blocks for a couple of seconds, releases them one at a time — and
        then, with nothing left to decode, runs the product's own loop over
        its own letters: a reticle closes on one random character, the
        character seals and churns behind it, an interceptor crosses the
        line, and the character comes back on impact and cools. Then a
        couple of seconds of quiet and another character, for as long as the
        page is open — the three commands below this heading, said once
        every eight seconds by the heading itself. Top of ТЗ §30's attention
        hierarchy, and the longest, most complex motion in the product to
        say so. See `motion/CipherTitle`.
      */}
      <CipherTitle
        className={`${styles.title} boot-title`}
        text="SOMETHING IS COMING"
        enabled={entering}
        delay={TITLE_SCRAMBLE.delay}
        duration={TITLE_SCRAMBLE.duration}
        hold={TITLE_CIPHER.hold}
        churn={TITLE_CIPHER.churn}
        unlock={TITLE_CIPHER.unlock}
      />
      {/*
        ТЗ §2 — the threat stated the way a system would state it.

        It replaces "We don't know what it is. We only know it's getting
        closer" — which was conversational and hedged twice. This says the
        same two facts (something is coming, its path is hidden) in the
        register the rest of the interface uses, and the second half now
        names the exact thing the protocol encrypts: the trajectory, which
        is the word the status line below repeats.
      */}
      <p className={`${styles.subtitle} boot-subtitle`}>
        An unknown threat is approaching. Its trajectory remains hidden.
      </p>
      {/*
        Three spans rather than one string, because the stagger *is* this
        line's motion (ТЗ §11) and a stagger needs something to stagger.
        They are separate elements only for that reason, so the spacing
        between them stays word spacing rather than a gap.
      */}
      <p className={`${styles.tagline} boot-tagline`}>
        {TAGLINE.map((phrase) => (
          <span key={phrase}>{phrase}</span>
        ))}
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={openCreateLobbyModal}
          className={`${styles.cta} boot-cta motion-roll-host`}
          data-guide="create-operation"
        >
          <RollingLabel>Create Operation</RollingLabel>
        </Button>
        {/*
          The two answers that are not "create one".

          The hero used to offer exactly one action, and it was the most
          expensive one in the product: creating an operation costs a start
          prize pool plus the protocol's creation fee, while joining an
          existing one costs an entry. A first-time visitor had no route to
          the cheaper half of the game at all — the operations directory was
          reachable only by clicking a *statistic* in the header, which is a
          number, not a way in.

          They share one boot step because they are one row. The hero's rule
          is that no two lines arrive the same way; these are two halves of
          the same line.

          And they are *navigation*, not a second and third call to action.
          They used to be set like the tagline and to roll under the pointer
          exactly as the CTA above them does, which put four things asking
          to be pressed in one column — the row is now a quiet mono readout
          at about half the button's weight, with cyan signal marks holding
          it together (`SpaceHero.module.css`). The roll went with the
          change: it is the CTA's gesture, and borrowing it here is what made
          these read as buttons in the first place.

          Three destinations, in the order somebody actually wants them:
          take a seat, watch a round first, or read the rules.
        */}
        <div className={`${styles.secondary} boot-docs`}>
          <Link
            to="/operations"
            viewTransition
            className={`${styles.nav} motion-nav motion-press`}
            data-guide="join-operation"
            onPointerMove={traceToPointer}
          >
            {/* The trace lives inside the label so the two move as one thing
                under the pointer — see the stylesheet. */}
            <span className={`${styles.navLabel} motion-nav-label`}>
              Join Operation
              <span className={styles.navTrace} data-trace aria-hidden="true" />
              {/*
                Hidden from the name rather than left in it: this is a mark
                saying which of the three is somewhere you go to *do*
                something, and a link called "Join Operation →" is a link
                with a piece of decoration read out at the end of it.
              */}
              <span className={styles.navArrow} aria-hidden="true">
                →
              </span>
            </span>
          </Link>
          <span className={`${styles.navMark} motion-nav-mark`} aria-hidden="true" />
          {/*
            A plain anchor, not a `Link`.

            The guided tour is a second application root with a router of its
            own (see `guide/GuideApp`), which is what lets it drive the real
            screens while the address bar stays put. It has to be entered by
            loading the document — a client-side navigation would look for a
            route that deliberately does not exist.
          */}
          <a
            href="/guide"
            className={`${styles.nav} motion-nav motion-press`}
            onPointerMove={traceToPointer}
          >
            <span className={`${styles.navLabel} motion-nav-label`}>
              Guide
              <span className={styles.navTrace} data-trace aria-hidden="true" />
            </span>
          </a>
          <span className={`${styles.navMark} motion-nav-mark`} aria-hidden="true" />
          <Link
            to="/docs"
            viewTransition
            className={`${styles.nav} motion-nav motion-press`}
            onPointerMove={traceToPointer}
          >
            <span className={`${styles.navLabel} motion-nav-label`}>
              Rules
              <span className={styles.navTrace} data-trace aria-hidden="true" />
            </span>
          </Link>
        </div>
      </div>
      {/*
        ТЗ §11, §17 — the confidentiality claim, shown rather than asserted.
        The threat's trajectory is the one value the whole protocol is built
        to keep sealed, so the hero prints it *redacted*: a label, and where
        the number would be, the theme's cipher glyph. That says more about
        what this game is than a sentence claiming privacy would, and it
        costs one line under the actions rather than a block of its own.

        The provider credit rides the same line at lower emphasis. AEGYLAX is
        the brand; whoever computes the ciphertext is a footnote, and it only
        appears when there is genuinely a confidential layer behind the build
        (see `ProviderThemeProvider`).

        ТЗ §16 — and it is the most technical motion on the page after the
        title, because it is the one line describing a cryptographic system:
        the label lands, the cipher blocks churn, ENCRYPTED decodes, the
        provider signs. Four stages, in that order, out of one component's
        staggered delays.
      */}
      <p className={`${styles.seal} boot-seal`}>
        <span className={styles.sealTerm}>Trajectory</span>
        {/*
          ТЗ §12-§15 — the other element on the page that never stops, and
          the quieter of the two: the title faults once every few seconds
          where this simply keeps working.

          The blocks first scramble *to* the cipher glyph rather than away
          from it: where every other scramble here resolves into meaning,
          this one resolves into redaction, which is the joke the whole line
          is making. Then they keep working — a signal runs along the groups
          left to right, forever, because the claim this line makes is that
          ciphertext is being processed right now and a static row of blocks
          says only that it once was.

          Split into groups so the wave has something to travel through. The
          glyph is a theme asset (`███ ███ ███` for Fhenix, dots elsewhere),
          so the split is on whitespace rather than on a fixed count — a
          theme with two groups or four gets a wave of two or four, and one
          with no spaces at all still renders as a single block.
        */}
        <CipherBlocks
          glyph={theme.assets.cipherGlyph}
          entering={entering}
          className={styles.sealValue}
        />
        {/*
          The state, said out loud rather than left to the bars (ТЗ §11).
          It was a screen-reader-only word before, which meant the line
          claimed nothing to anyone looking at it — the redaction had to be
          *read as* a redaction. Naming it costs one short chip and turns a
          decorative row of blocks into the product's actual claim. It stays
          one text node, so it is still exactly what a screen reader gets.

          Its chip engages in CSS (`boot-seal-state`) while the word inside
          decodes here — a border coming live around a value resolving, which
          is the two halves of "encrypted" happening at once.
        */}
        <ScrambleText
          className={`${styles.sealState} boot-seal-state seal-live`}
          /* ТЗ §16 — step 3 of the line's wave: the signal reaches the badge
             after it has crossed the blocks. See `app/motion.css`. */
          style={{ ['--wave-step' as string]: 3 }}
          text="encrypted"
          enabled={entering}
          delay={SEAL_STATE_SCRAMBLE.delay}
          duration={SEAL_STATE_SCRAMBLE.duration}
        />
        {credit ? (
          <>
            <span className={styles.sealDivider} aria-hidden="true" />
            {/*
              The claim stays quiet; the provider is the word worth seeing.
              One span so the line is still one string to a screen reader
              and to anyone searching the page for it.
            */}
            <span className={styles.sealCredit}>
              {credit.lead}
              {credit.name ? (
                <ScrambleText
                  className={`${styles.sealCreditName} seal-live`}
                  /* ТЗ §17 — step 4, and the end of the line. It must never
                     pulse on a rhythm of its own; sharing the wave is what
                     makes the whole row one status indicator. */
                  style={{ ['--wave-step' as string]: 4 }}
                  text={credit.name}
                  enabled={entering}
                  delay={SEAL_CREDIT_SCRAMBLE.delay}
                  duration={SEAL_CREDIT_SCRAMBLE.duration}
                />
              ) : null}
            </span>
          </>
        ) : null}
      </p>
    </div>
  )
}
