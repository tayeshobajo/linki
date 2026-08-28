/**
 * Shared headline parsing for flagship-LinkedIn identity data.
 *
 * LinkedIn headlines compress title + company into one rendered line, most
 * commonly as "<Title> at <Company>" (sometimes with trailing noise after the
 * company, e.g. "Founder & CEO at Acme · Nashville" — in practice the search
 * card renders that noise as separate lines, but profiles can inline it).
 *
 * This parser was originally embedded in pages/api/lookup.ts (company slicing,
 * lookup.ts ~165-169 at commit eea1967). The enrichment pipeline
 * (lib/linkedin/profile-lite.ts) needs the identical derivation, so it lives
 * here once and both callers import it — a drift between search-card company
 * parsing and profile company parsing would silently corrupt ranking inputs.
 */

export interface HeadlineParts {
  /** "Founder & CEO at Acme" → "Acme"; null when no " at " segment. */
  company: string | null;
  /**
   * "Founder & CEO at Acme" → "Founder & CEO".
   * When there is no " at " segment the headline is typically a bare title
   * ("Data Scientist") — that becomes the title, and company stays null.
   */
  title: string | null;
}

const MAX_COMPANY = 120;
const MAX_TITLE = 120;

/**
 * Derive {company, title} from a headline line.
 * Never throws; returns nulls when the headline is empty/absent.
 * Values are length-clamped to match the lookup.ts card-parsing contract.
 */
export function parseHeadline(headline: string | null | undefined): HeadlineParts {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const h = norm(headline ?? "");
  if (!h) return { company: null, title: null };

  const atIdx = h.lastIndexOf(" at ");
  if (atIdx > 0) {
    const company = norm(h.slice(atIdx + 4)).slice(0, MAX_COMPANY) || null;
    const title = norm(h.slice(0, atIdx)).slice(0, MAX_TITLE) || null;
    return { company, title };
  }

  // No " at " segment: treat the whole line as the title, company unknown.
  return { company: null, title: h.slice(0, MAX_TITLE) || null };
}
