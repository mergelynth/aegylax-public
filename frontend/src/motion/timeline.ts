/**
 * The JavaScript half of the entrance clock.
 *
 * The CSS half is the table at the top of `src/app/motion.css`, and these
 * belong to the same column — they are here only because a scramble and a
 * staggered wake-up cannot be expressed as keyframes. Read the two together:
 * this file's numbers are interleaved with that one's, not sequential after
 * it.
 *
 *   0ms     header wipe                      (css)
 *   240ms   wallet wipe                      (css)
 *   300ms   title carrier fades in           (css)
 *   320ms   SOMETHING IS COMING decodes      (here)
 *   380ms   HUD icons light, 70ms apart      (css)
 *   400ms   Earth begins fading up           (css)
 *   420ms   wallet network light             (css)
 *   560ms   shield lights                    (css)
 *   620ms   subtitle unmasks                 (css)
 *   760ms   tagline phrases, 90ms apart      (css)
 *   940ms   CTA activates                    (css)
 *  1000ms   browse link rolls in             (css)
 *  1060ms   docs link rolls in               (css)
 *  1120ms   trajectory line appears          (css)
 *  1180ms   cipher blocks rearrange          (here)
 *  1260ms   ENCRYPTED decodes + seal engages (here + css)
 *  1420ms   provider credit decodes          (here)
 *  1500ms   Earth signals wake, staggered    (here)
 *  1500ms   countdown settles                (css)
 *  1900ms   — every block has arrived —
 *  1950ms   AEGYLAX types, 140ms per letter   (here)
 *  3950ms   PLANETARY DEFENSE + the shield    (css, `.sign-*`)
 *
 * The title is the one row that does not end where the table says. Its
 * decode at 320ms runs until ~1.7s and leaves five or six characters
 * sealed; they churn until ~4.1s, release one at a time until ~5.8s, and
 * from then on the heading runs the game over its own letters on a loop
 * that never finishes — a reticle closing on one character, the character
 * sealed behind it, an interceptor crossing the line, the hit, and round
 * again.
 * None of that is gated on `[data-boot]` — see `TITLE_CIPHER` below and
 * `motion/CipherTitle`.
 *
 * The screen is complete at 1900ms, which is what `BOOT_SEQUENCE_MS` is
 * sized against. Everything after that is the brand corner signing itself,
 * and none of it is gated on `[data-boot]` — the components apply those
 * classes only on a document load, so the window closing underneath them
 * changes nothing. See "the brand signs itself" in `app/motion.css`.
 */

/**
 * The wordmark, struck one letter at a time — and the last thing to happen
 * anywhere on the page.
 *
 * It used to open the sequence at 150ms. It now waits for every other block
 * on the page to land, and the rest of its own corner waits for *it*: the
 * subtitle and the protocol shield are both held back until the last letter
 * has finished cooling, then arrive together. So the brand corner is empty
 * for the first two seconds and resolves in one movement at the end — the
 * system comes up, and only then says what it is.
 *
 * A quarter of the speed it opened at, and half of what it settled on.
 *
 * At 70ms a letter the typing was over almost as soon as it registered. 140ms
 * made the strike travel followable; 280ms makes it *readable* — at this
 * cadence the word is being written rather than appearing, and the eye has
 * time to arrive at each letter before the next one lands. It is the only
 * motion in the product allowed to take this long, and it earns it by being
 * the one that writes the brand: everything else on screen has finished by
 * 1900ms, so nothing is waiting on it.
 *
 * The letter cadence is the only number that moved. Each letter's glow still
 * cools over `duration` (1120ms), because that is the strike itself rather
 * than the pace of the word — slowing the cooling too would have turned a
 * deliberate hand into a tired one.
 *
 * The last letter now lands at 3630ms and has finished cooling by 4750ms.
 * Both are load-bearing: `.sign-*` in `motion.css` waits for the first of
 * them, and a test holds the two files to it.
 *
 * Deliberately a different mechanism from the hero title's decode — see
 * `motion/NeonType`.
 */
export const LOGO_TYPE = { delay: 1950, step: 280, duration: 1120 } as const

/**
 * ТЗ §9 — the page's loudest motion, and the longest scramble.
 *
 * At the top of ТЗ §30's attention hierarchy, which is why it is the one
 * given the longest run: amplitude and duration are how a hierarchy is said
 * out loud, not just ordering.
 *
 * Twice the 700ms it was. At that speed the wave travelling out from the
 * centre of the line was over in about the time it takes to notice it had
 * started — the eye registered "the heading arrived scrambled" rather than
 * the characters locking one after another, which is the part worth
 * watching. At 1400ms the front is slow enough to follow across the word.
 *
 * It is the *decode* that doubled, not the hold: `TITLE_CIPHER` below is
 * untouched, so the sealed characters still churn for the same two and a
 * half seconds. Everything downstream of the decode simply starts 700ms
 * later — the line finishes at ~5.8s where it used to finish at ~5.1s, and
 * nothing on the page is scheduled against it.
 */
export const TITLE_SCRAMBLE = { delay: 320, duration: 1400 } as const

/**
 * ТЗ §9 — what the title does *instead of* finishing.
 *
 * The scramble above no longer resolves the whole line. `hold` characters,
 * picked at random on every load, stay behind as sealed slots and churn
 * cipher → digit → letter for `churn` ms while the rest of the heading sits
 * there readable; then they give themselves up `unlock` ms apart, in a
 * random order, each flashing as it does.
 *
 * `hold` is an upper bound rather than a count: the picker refuses to seal
 * two adjacent characters, so on a nineteen-character line it lands on five
 * or six. Three sealed slots in a row would stop reading as "some of this
 * is still encrypted" and start reading as a word with letters missing.
 *
 * The numbers are long on purpose. This is the one motion in the product
 * that is allowed to still be running after the entrance is over — the
 * screen is complete at 1900ms whatever the title is doing, because every
 * other element's clock is independent of this one. Two and a half seconds
 * of churn is long enough that the sealed slots read as a state the line is
 * *in* rather than as a stage it is passing through, which is the point:
 * the headline says something is coming, and the line itself will not tell
 * you all of it.
 *
 * The intercept pass that follows carries its own timings — they are
 * defaults in `motion/useInterceptPass`, not part of this clock, because it
 * runs for as long as the page is open and nothing else is ever scheduled
 * against it.
 */
export const TITLE_CIPHER = { hold: 6, churn: 2400, unlock: 280 } as const

/**
 * ТЗ §16 — the cryptographic handshake, in the order it reads.
 *
 * Four staggered stages rather than one animation, because the line is
 * making four separate claims and they resolve in sequence: the label
 * names what is hidden, the blocks churn to show it is *being* hidden,
 * ENCRYPTED resolves to say the state, and the provider signs it.
 */
export const SEAL_BLOCKS_SCRAMBLE = { delay: 1180, duration: 420 } as const
export const SEAL_STATE_SCRAMBLE = { delay: 1260, duration: 420 } as const
export const SEAL_CREDIT_SCRAMBLE = { delay: 1420, duration: 380 } as const

/**
 * ТЗ §19 — when the planet's surface starts waking, and how far apart the
 * markers come up.
 *
 * Begins while Earth is still fading up (the dawn runs 400–1900ms), which
 * is the point: the signals are already alive on a planet that is still
 * arriving, so it materializes *with* activity rather than switching on
 * afterwards. They fade with it — the markers are inside the element the
 * opacity ramp is on — so their own wake reads on top of a planet that is
 * by then most of the way visible.
 *
 * The stagger is 18ms rather than the 26ms it was because the scatter got
 * denser — the surface now carries around fifty markers instead of thirty-
 * five, and at 26ms apiece the last one would have woken at ~2.8s, after
 * the brand corner has finished signing itself. What is fixed here is how
 * long the wake takes end to end (~0.9s), not the gap between two markers:
 * this number is a division of that window by however many markers the
 * sampler produced, and it moves when the density does.
 */
export const SIGNALS_WAKE = { delay: 1500, stagger: 18, duration: 420 } as const
