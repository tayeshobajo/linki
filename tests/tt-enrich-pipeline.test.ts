/**
 * Validation + dedupe logic tests for the TT enrichment pipeline.
 *
 * Run: npm test (node --test, no new deps).
 *
 * These cover pure logic only — no network, no browser, no LinkedIn traffic
 * (build-phase requirement; live probes happen on the droplet post-deploy).
 * Imports only lib/tt/params.ts (zero-dep) + lib/linkedin/headline.ts (pure)
 * so the test never pulls in playwright/better-sqlite3 via route modules.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePages,
  dedupeCandidates,
  validateEnrichUrls,
  MAX_PAGES,
  MAX_CANDIDATES,
  MAX_ENRICH_URLS,
  ENRICH_URL_RE,
  parseSearchName,
  isRiskWall,
  isRedirectWallError,
  candidateSlugFromUrl,
} from "../lib/tt/params.ts";
import { parseHeadline } from "../lib/linkedin/headline.ts";

// ─── pages param validation (POST /api/tt/lookup body) ───────────────────────

test("pages: defaults to 1 when absent", () => {
  assert.equal(parsePages(undefined), 1);
  assert.equal(parsePages(null), 1);
});

test("pages: accepts valid integers 1-3", () => {
  assert.equal(parsePages(1), 1);
  assert.equal(parsePages(2), 2);
  assert.equal(parsePages(3), 3);
});

test("pages: rejects 4 and above (over cap)", () => {
  assert.equal(parsePages(4), null);
  assert.equal(parsePages(10), null);
});

test("pages: rejects negatives and zero", () => {
  assert.equal(parsePages(0), null);
  assert.equal(parsePages(-1), null);
  assert.equal(parsePages(-3), null);
});

test("pages: rejects non-integers", () => {
  assert.equal(parsePages(1.5), null);
  assert.equal(parsePages("2"), null);
  assert.equal(parsePages(true), null);
  assert.equal(parsePages(NaN), null);
});

test("pages: exposed constants match the brief (1-3 pages, 25 candidates, 5 urls)", () => {
  assert.equal(MAX_PAGES, 3);
  assert.equal(MAX_CANDIDATES, 25);
  assert.equal(MAX_ENRICH_URLS, 5);
});

// ─── enrich URL validation (POST /api/tt/enrich body) ────────────────────────

test("enrich urls: accepts valid flagship /in/ URLs (with/without trailing slash)", () => {
  assert.deepEqual(
    validateEnrichUrls(["https://www.linkedin.com/in/david-andrews-0868a2132", "https://www.linkedin.com/in/jane-doe/"]),
    ["https://www.linkedin.com/in/david-andrews-0868a2132", "https://www.linkedin.com/in/jane-doe/"]
  );
});

test("enrich urls: rejects arrays over 5 items", () => {
  const six = Array.from({ length: 6 }, (_, i) => `https://www.linkedin.com/in/user-${i}`);
  assert.equal(validateEnrichUrls(six), null);
  const five = Array.from({ length: 5 }, (_, i) => `https://www.linkedin.com/in/user-${i}`);
  assert.equal(validateEnrichUrls(five)?.length, 5);
});

test("enrich urls: rejects empty and non-array bodies", () => {
  assert.equal(validateEnrichUrls([]), null);
  assert.equal(validateEnrichUrls(undefined), null);
  assert.equal(validateEnrichUrls("https://www.linkedin.com/in/x"), null);
});

test("enrich urls: rejects non-/in/ and malformed URLs", () => {
  const bad = [
    "https://www.linkedin.com/in/david-andrews/detail/", // /in/ subroute
    "https://www.linkedin.com/sales/lead/abc",           // Sales Nav
    "https://www.linkedin.com/company/trust-tai",        // company page
    "https://www.linkedin.com/pub/john",                 // legacy pub
    "https://evil.com/in/david-andrews",                 // off-host
    "http://www.linkedin.com/in/david-andrews",          // not https
    "",                                                  // empty
    "not a url",                                         // junk
  ];
  for (const u of bad) assert.ok(!ENRICH_URL_RE.test(u), `should reject: ${u}`);
  assert.equal(validateEnrichUrls([bad[0]]), null);
  assert.equal(validateEnrichUrls([good(), bad[3]]), null); // one bad apple kills batch
});

function good() {
  return "https://www.linkedin.com/in/valid-user";
}

// ─── search_name validation (nav-first selector, POST /api/tt/enrich body) ──

test("search_name: absent/null → null (legacy mode)", () => {
  assert.equal(parseSearchName(undefined), null);
  assert.equal(parseSearchName(null), null);
});

test("search_name: accepts valid trimmed names (2-200 chars)", () => {
  assert.equal(parseSearchName("  Isaac Meek  "), "Isaac Meek");
  assert.equal(parseSearchName("A".repeat(200)), "A".repeat(200));
  assert.equal(parseSearchName("Jo"), "Jo");
});

test("search_name: rejects invalid values (present-but-invalid → empty-string sentinel)", () => {
  assert.equal(parseSearchName(""), "");       // empty after trim
  assert.equal(parseSearchName("   "), "");    // whitespace only
  assert.equal(parseSearchName("x"), "");      // 1 char
  assert.equal(parseSearchName("A".repeat(201)), ""); // over 200
  assert.equal(parseSearchName(42), "");       // non-string
  assert.equal(parseSearchName(true), "");     // non-string
});

// ─── risk-wall detection (nav-first + legacy stop-on-wall) ───────────────

test("isRiskWall: matches login/authwall/checkpoint/uas URLs", () => {
  assert.ok(isRiskWall("https://www.linkedin.com/authwall?trk=guest_homepage-basic_nav-header-signin"));
  assert.ok(isRiskWall("https://www.linkedin.com/uas/login"));
  assert.ok(isRiskWall("https://www.linkedin.com/checkpoint/challenge/verify"));
  assert.ok(isRiskWall("https://www.linkedin.com/login/fromgoogleauth"));
});

test("isRiskWall: passes search + profile URLs", () => {
  assert.ok(!isRiskWall("https://www.linkedin.com/search/results/all/?keywords=Isaac+Meek"));
  assert.ok(!isRiskWall("https://www.linkedin.com/in/isaac-meek/"));
});

test("isRedirectWallError: matches ERR_TOO_MANY_REDIRECTS only", () => {
  assert.ok(isRedirectWallError(new Error("net::ERR_TOO_MANY_REDIRECTS at https://www.linkedin.com")));
  assert.ok(isRedirectWallError("net::ERR_TOO_MANY_REDIRECTS"));
  assert.ok(!isRedirectWallError(new Error("net::ERR_CONNECTION_REFUSED")));
  assert.ok(!isRedirectWallError(null));
});

// ─── /in/<slug> extraction (anchor matching on the search results page) ──

test("candidateSlugFromUrl: extracts /in/<slug> paths", () => {
  assert.equal(candidateSlugFromUrl("https://www.linkedin.com/in/jane-doe/"), "/in/jane-doe");
  assert.equal(candidateSlugFromUrl("https://www.linkedin.com/in/david-andrews-0868a2132"), "/in/david-andrews-0868a2132");
  assert.equal(candidateSlugFromUrl("https://www.linkedin.com/company/trust-tai"), null);
  assert.equal(candidateSlugFromUrl("not a url"), null);
});

// ─── lookup candidate dedupe (merged across search pages) ────────────────────

test("dedupe: same /in/ URL on page 1 and page 2 collapses to one entry", () => {
  const p1 = [
    { linkedin_url: "https://www.linkedin.com/in/a" },
    { linkedin_url: "https://www.linkedin.com/in/b" },
  ];
  const p2 = [
    { linkedin_url: "https://www.linkedin.com/in/b" }, // repeat from page 1
    { linkedin_url: "https://www.linkedin.com/in/c" },
  ];
  const merged = dedupeCandidates([...p1, ...p2]);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((c) => c.linkedin_url),
    ["https://www.linkedin.com/in/a", "https://www.linkedin.com/in/b", "https://www.linkedin.com/in/c"]
  );
});

test("dedupe: first occurrence wins (page-1 ordering preserved)", () => {
  const p1 = [{ linkedin_url: "https://www.linkedin.com/in/x", full_name: "Page One X" }];
  const p2 = [{ linkedin_url: "https://www.linkedin.com/in/x", full_name: "Page Two X" }];
  const merged = dedupeCandidates([...p1, ...p2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].full_name, "Page One X");
});

test("dedupe: caps merged candidates at 25", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    linkedin_url: `https://www.linkedin.com/in/user-${i}`,
  }));
  assert.equal(dedupeCandidates(many).length, 25);
});

// ─── shared headline parser (company/title derivation) ───────────────────────

test("headline: 'Title at Company' splits into title + company", () => {
  assert.deepEqual(parseHeadline("Founder & CEO at Acme"), {
    company: "Acme",
    title: "Founder & CEO",
  });
});

test("headline: multiple ' at ' uses the last (company is the tail)", () => {
  assert.deepEqual(parseHeadline("Manager at Sales at Acme Corp"), {
    company: "Acme Corp",
    title: "Manager at Sales",
  });
});

test("headline: bare title line (no ' at ') → title only, null company", () => {
  assert.deepEqual(parseHeadline("Data Scientist"), {
    company: null,
    title: "Data Scientist",
  });
});

test("headline: empty/null headline → both null, never throws", () => {
  assert.deepEqual(parseHeadline(""), { company: null, title: null });
  assert.deepEqual(parseHeadline(null), { company: null, title: null });
  assert.deepEqual(parseHeadline(undefined), { company: null, title: null });
});

test("headline: whitespace is normalized", () => {
  assert.deepEqual(parseHeadline("  Founder   at   Acme  "), {
    company: "Acme",
    title: "Founder",
  });
});
