import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AdvancedRules } from '../components/docs/AdvancedRules'
import { StepCard } from '../components/docs/StepCard'
import styles from '../components/docs/HowToPlay.module.css'
import { useProviderTheme } from '../theme'
import { useUiStore } from '../stores/uiStore'

/**
 * How to play — the whole game in thirty seconds, then the details.
 *
 * The home screen already says it: an unknown attack is approaching, and
 * its trajectory is hidden. After half a minute here a visitor should be
 * able to repeat that in their own words, plus the rest — buy clues, pick
 * a place and a time, one shot, first hit takes the pool. Probe physics,
 * jackpot, Day X and protocol constants stay in `AdvancedRules`.
 *
 * Nothing here moves. The motion in this product belongs where the game is.
 */
export function DocsPage() {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const { theme, providerCredit } = useProviderTheme()
  const openCreateLobbyModal = useUiStore((state) => state.openCreateLobbyModal)

  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>
            <Link to="/" viewTransition className={styles.back}>
              Home
            </Link>
            <span className={styles.kickerDot} aria-hidden="true" />
            {/*
              The same content, played instead of read. Somebody who has
              opened How to Play is exactly the person who might rather step
              through a round than read about one, and this is the only page
              where offering that is not an interruption.
            */}
            {/*
              A plain anchor, not a `Link`: the tour is a separate
              application root with its own router (see `guide/GuideApp`),
              so it has to be entered by loading the document rather than by
              a client-side navigation into a route that no longer exists.
            */}
            <a href="/guide" className={styles.back}>
              Guided tour
            </a>
            <span className={styles.kickerDot} aria-hidden="true" />
            <a href="#advanced" className={styles.back} onClick={() => setAdvancedOpen(true)}>
              Advanced rules
            </a>
          </p>
          <p className={styles.pageLabel}>How to play</p>
          <h1 className={styles.title}>Stop the attack. Win the pool.</h1>
          <div className={styles.heroLead}>
            <p>An unknown attack is approaching Earth. You can&apos;t see its path.</p>
            <p>
              Everyone puts money into the pool. Use clues to figure out where and when to intercept
              it. You get one shot. Hit it first and the pool is yours.
            </p>
          </div>
        </div>
        <p className={styles.goal}>
          <span className={styles.goalLabel}>Your goal</span>
          Find the attack → choose where + when to intercept → hit it first → take the pool.
        </p>
      </header>

      <section className={styles.overview} aria-labelledby="overview-heading">
        <h2 id="overview-heading" className={styles.blockTitle}>
          The game in 30 seconds
        </h2>
        <ol className={styles.overviewList}>
          <li className={styles.overviewItem}>
            <span className={styles.overviewIndex} aria-hidden="true">
              01
            </span>
            <p className={styles.overviewName}>Join</p>
            <p className={styles.overviewText}>Pay to enter the game.</p>
          </li>
          <li className={styles.overviewItem}>
            <span className={styles.overviewIndex} aria-hidden="true">
              02
            </span>
            <p className={styles.overviewName}>Get clues</p>
            <p className={styles.overviewText}>Buy information that shows where the attack could be.</p>
          </li>
          <li className={styles.overviewItem}>
            <span className={styles.overviewIndex} aria-hidden="true">
              03
            </span>
            <p className={styles.overviewName}>Take your shot</p>
            <p className={styles.overviewText}>Choose a place and a time. You get one shot.</p>
          </li>
          <li className={styles.overviewItem}>
            <span className={styles.overviewIndex} aria-hidden="true">
              04
            </span>
            <p className={styles.overviewName}>Win</p>
            <p className={styles.overviewText}>Intercept it first. Take the pool.</p>
          </li>
        </ol>
        <p className={styles.overviewDone}>That&apos;s it.</p>
      </section>

      <section className={styles.walkthrough} aria-labelledby="steps-heading">
        <h2 id="steps-heading" className={styles.blockTitle}>
          How each step works
        </h2>

        <div className={styles.walkthroughGrid}>
          <StepCard id="join" index="01" title="Join a game" lead="Put money into the pool.">
            <p className={styles.stepText}>
              Someone creates a game and sets the entry price. Everyone who joins pays the same
              amount. All entry fees go into one pool.
            </p>
            <p className={styles.stepNote}>The winner takes the pool.</p>
            <p className={styles.stepNote}>When the game starts, the attack launches.</p>
          </StepCard>

          <StepCard
            id="find"
            index="02"
            title="Find the attack"
            lead="Buy clues to narrow down where it can be."
            featured
          >
            <p className={styles.stepText}>
              You cannot see the attack or its path. You can buy clues that reveal information about
              its location.
            </p>
            <p className={styles.stepText}>
              The more clues you have, the smaller the possible area becomes.
            </p>
            <p className={styles.stepText}>
              A Recon Probe is a clue. It tells you which part of the sky the attack is coming
              through — a wide area, not a point.
            </p>
            <aside className={styles.aside}>
              <p className={styles.asideTitle}>The important part</p>
              <p className={styles.stepText}>You never see the attack.</p>
              <p className={styles.stepText}>You only see information about where it could be.</p>
              <p className={styles.stepText}>Your job is to use that information to make your best guess.</p>
            </aside>
          </StepCard>

          <StepCard
            id="shoot"
            index="03"
            title="Take your shot"
            lead="Choose a place and a time. Then fire."
          >
            <p className={styles.stepText}>You get one shot per round.</p>
            <p className={styles.stepText}>Choose:</p>
            <ul className={styles.choose}>
              <li>where you think the attack will be</li>
              <li>when you think it will be there</li>
            </ul>
            <p className={styles.stepText}>Then fire.</p>
            <p className={styles.stepNote}>Too early, too late, or the wrong place = miss.</p>
          </StepCard>

          <StepCard id="win" index="04" title="Hit it first" lead="The first successful hit wins the pool.">
            <p className={styles.stepText}>If your shot hits the attack, you win the pool.</p>
            <ul className={styles.rules}>
              <li>
                <strong>One player hits:</strong> they take the whole pool.
              </li>
              <li>
                <strong>Several players hit:</strong> they share the pool.
              </li>
              <li>
                <strong>Nobody hits:</strong> the pool rolls into the next round.
              </li>
            </ul>
          </StepCard>
        </div>
      </section>

      <section id="sealed" className={styles.fair}>
        <div>
          <h2 className={styles.fairTitle}>Fair by design</h2>
          <p className={styles.fairLine}>The attack&apos;s path is hidden while the game is running.</p>
          <p className={styles.fairLine}>
            Nobody can see where it will go — not players, not the game creator.
          </p>
        </div>
        {providerCredit ? (
          <p className={styles.fairCredit}>Confidential execution · {theme.assets.providerName}</p>
        ) : null}
      </section>

      <section className={styles.cta}>
        <p className={styles.ctaLine}>That&apos;s the whole game.</p>
        <button type="button" className={styles.ctaButton} onClick={openCreateLobbyModal}>
          Create Operation
        </button>
        {/*
          Under the call to action rather than beside it: creating an
          operation is still the thing this page is asking for, and the
          walkthrough is for the reader who got to the bottom and would
          rather see one first. No wallet, so it costs them nothing to try.
        */}
        <p className={styles.ctaAlt}>
          or{' '}
          <a href="/guide" className={styles.ctaAltLink}>
            take the guided tour
          </a>{' '}
          — no wallet needed
        </p>
      </section>

      <AdvancedRules open={advancedOpen} onToggle={setAdvancedOpen} />
    </article>
  )
}
