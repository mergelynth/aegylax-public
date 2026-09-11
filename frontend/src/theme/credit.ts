/**
 * Splitting a provider credit into the part that is prose and the part that
 * is a name.
 *
 * "Confidential execution by Fhenix CoFHE" is one sentence and one fact, so
 * the theme stores it as one string — but the UI wants to weight its two
 * halves differently: the claim stays quiet, the provider is the word worth
 * seeing. Doing that means knowing where the name starts, and the theme
 * already knows the name (`assets.providerName`).
 *
 * A function rather than two more fields on `ThemeAssets` because the two
 * halves must not be able to disagree. If a provider could state a lead-in
 * and a name separately, a theme could ship a credit that reads
 * "Confidential execution by Inco" over a name of "Fhenix CoFHE" — and the
 * credit is the app's claim about whose cryptography it is resting on. One
 * string, split at read time, cannot drift.
 *
 * Falls back to the whole credit as prose when the name is not the tail of
 * it — the mock engine's "No confidentiality — mock engine" is exactly that
 * case, and it should stay one unhighlighted line rather than get the
 * treatment reserved for a provider being credited.
 */
export interface CreditParts {
  /** Everything before the provider's name, including its trailing space. */
  lead: string
  /** The provider's name, or null when the credit does not end with it. */
  name: string | null
}

export function splitProviderCredit(credit: string, providerName: string): CreditParts {
  const name = providerName.trim()
  if (name && credit.endsWith(name) && credit.length > name.length) {
    return { lead: credit.slice(0, credit.length - name.length), name }
  }
  return { lead: credit, name: null }
}
