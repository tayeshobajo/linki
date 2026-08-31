/**
 * Nav-first enrichment engine tests — fully mocked, zero network/browser.
 *
 * Run: npm test (node --test). The engine (lib/tt/enrich-nav.ts) consumes a
 * structural NavPage interface, so these tests script a fake page through
 * the exact navigation choreography: search load → per-candidate anchor
 * lookup → click → extract on the navigated page → goBack → pacing.
 *
 * Covers: hard cap of 3, given-order processing, silent skip when an anchor
 * is absent (no cold goto, no pagination), wall-stop with partials +
 * stopped_reason:"risk_wall" (search-load wall, post-click wall, redirect
 * wall on goto), and extraction stamping the navigated URL.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enrichNavFirst,
  searchUrlFor,
  canonicalizeUrl,
  type NavPage,
  type NavLocator,
  type NavProfileLite,
} from "../lib/tt/enrich-nav.ts";
import { MAX_NAV_ENRICH_URLS } from "../lib/tt/params.ts";

// ─── test doubles ───────────────────────────────────────────────────────

interface ScriptedAnchor {
  hrefSlug: string; // which /in/<slug> this anchor matches
}

/** Fake locator matching `a[href*="/in/<slug>"]` semantics. */
class FakeLocator implements NavLocator {
  page: FakePage;
  selector: string;
  constructor(page: FakePage, selector: string) {
    this.page = page;
    this.selector = selector;
  }
  first(): NavLocator { return this; }
  async count(): Promise<number> {
    const slug = this.selector.match(/a\[href\*="([^"]+)"\]/)?.[1] ?? "";
    return this.page.anchors.some((a) => a.hrefSlug === slug) ? 1 : 0;
  }
  async click(_options?: { timeout?: number }): Promise<void> {
    const slug = this.selector.match(/a\[href\*="([^"]+)"\]/)?.[1] ?? "";
    const hit = this.page.anchors.find((a) => a.hrefSlug === slug);
    if (!hit) throw new Error("locator not found");
    this.page.navLog.push(`click:${slug}`);
    // Click navigates to the profile (with search-tracking query noise).
    this.page.currentUrl = `https://www.linkedin.com${slug}?originalSubdomain=www`;
  }
}

/** Fake page: scripted URL state + anchor list + navigation log. */
class FakePage implements NavPage {
  currentUrl = "about:blank";
  anchors: ScriptedAnchor[] = [];
  navLog: string[] = [];
  gotoShouldThrowRedirectWall = false;
  /** URL to land on after a goBack (defaults back to the search page). */
  backUrl: string | null = null;

  url(): string { return this.currentUrl; }
  async goto(u: string, _opts?: { waitUntil?: string; timeout?: number }): Promise<unknown> {
    this.navLog.push(`goto:${u}`); // attempt is recorded even when it throws
    if (this.gotoShouldThrowRedirectWall) throw new Error("net::ERR_TOO_MANY_REDIRECTS");
    this.currentUrl = u;
    return null;
  }
  async goBack(_opts?: { waitUntil?: string; timeout?: number }): Promise<unknown> {
    this.navLog.push("goBack");
    this.currentUrl = this.backUrl ?? "https://www.linkedin.com/search/results/all/?keywords=x";
    return null;
  }
  async waitForTimeout(_ms: number): Promise<void> {}
  locator(sel: string): NavLocator { return new FakeLocator(this, sel); }
}

const PROFILE_IN = (slug: string, full_name: string, headline: string): NavProfileLite => ({
  url: `https://www.linkedin.com${slug}/`,
  full_name,
  headline,
  company: null,
  title: null,
  location: null,
});

/** Deps whose extraction reads the fake page's current URL. */
const fakeExtract = (page: NavPage, url: string): Promise<NavProfileLite> =>
  Promise.resolve(PROFILE_IN(new URL(page.url()).pathname, `Name ${url}`, `Headline ${url}`));

// ─── search URL + canonicalization ──────────────────────────────────────

test("searchUrlFor: URL-encodes the keywords with the GLOBAL_SEARCH_HEADER origin", () => {
  assert.equal(
    searchUrlFor("Isaac Meek"),
    "https://www.linkedin.com/search/results/all/?keywords=Isaac%20Meek&origin=GLOBAL_SEARCH_HEADER",
  );
});

test("canonicalizeUrl: drops query/hash noise from clicked hrefs", () => {
  assert.equal(
    canonicalizeUrl("https://www.linkedin.com/in/jane-doe/?originalSubdomain=www&trk=xyz"),
    "https://www.linkedin.com/in/jane-doe/",
  );
  assert.equal(canonicalizeUrl("not a url"), "not a url");
});

// ─── hard cap + ordering ─────────────────────────────────────────────────

test("nav-first: processes at most 3 URLs in the given order (hard cap)", async () => {
  const page = new FakePage();
  page.anchors = [
    { hrefSlug: "/in/one" }, { hrefSlug: "/in/two" }, { hrefSlug: "/in/three" },
    { hrefSlug: "/in/four" }, { hrefSlug: "/in/five" },
  ];
  const urls = [1, 2, 3, 4, 5].map((i) => `https://www.linkedin.com/in/${["one", "two", "three", "four", "five"][i - 1]}/`);
  const clicksBefore = page.navLog.length;
  const out = await enrichNavFirst(page, urls, "Jane Doe", { extract: fakeExtract });
  const clicks = page.navLog.filter((l) => l.startsWith("click:"));
  assert.deepEqual(clicks, ["click:/in/one", "click:/in/two", "click:/in/three"]);
  assert.equal(out.stopped_reason, null);
  assert.equal(out.profiles.length, 3);
  // The first URL in input order is the first profile out.
  assert.ok((out.profiles[0] as NavProfileLite).url.startsWith("https://www.linkedin.com/in/one"));
  // Cap constant is the contract: 3.
  assert.equal(MAX_NAV_ENRICH_URLS, 3);
  assert.ok(page.navLog.length - clicksBefore >= 3);
});

// ─── silent skip (no anchor) ─────────────────────────────────────────────

test("nav-first: anchor not on the page → silent skip, no cold goto, no pagination", async () => {
  const page = new FakePage();
  page.anchors = [{ hrefSlug: "/in/present" }];
  const out = await enrichNavFirst(
    page,
    ["https://www.linkedin.com/in/absent/", "https://www.linkedin.com/in/present/"],
    "Jane Doe",
    { extract: fakeExtract },
  );
  // Only one profile (the present one); the absent URL produced NO entry —
  // neither profile nor error — a false negative, accepted.
  assert.equal(out.profiles.length, 1);
  assert.equal((out.profiles[0] as NavProfileLite).url, "https://www.linkedin.com/in/present/");
  // No goto to any /in/ URL — the only goto is the single search load.
  const gotos = page.navLog.filter((l) => l.startsWith("goto:"));
  assert.equal(gotos.length, 1);
  assert.ok(gotos[0].startsWith("goto:https://www.linkedin.com/search/results/all/"));
});

// ─── wall stops ──────────────────────────────────────────────────────────

test("nav-first: wall on the search load → empty partials + stopped_reason risk_wall, never retry", async () => {
  const page = new FakePage();
  page.gotoShouldThrowRedirectWall = true;
  const out = await enrichNavFirst(
    page,
    ["https://www.linkedin.com/in/jane-doe/", "https://www.linkedin.com/in/john-doe/"],
    "Jane Doe",
    { extract: fakeExtract },
  );
  assert.equal(out.stopped_reason, "risk_wall");
  assert.deepEqual(out.profiles, []);
  // Exactly one goto attempt — never retried.
  assert.deepEqual(page.navLog.filter((l) => l.startsWith("goto:")).length, 1);
});

test("nav-first: wall after a click stops the loop with partials collected so far", async () => {
  const page = new FakePage();
  page.anchors = [{ hrefSlug: "/in/good" }, { hrefSlug: "/in/walled" }];
  let clickCount = 0;
  const origClick = FakeLocator.prototype.click;
  FakeLocator.prototype.click = async function (opts?: { timeout?: number }) {
    clickCount += 1;
    if (clickCount === 2) {
      // Second click lands on the wall instead of a profile.
      page.currentUrl = "https://www.linkedin.com/authwall?trk=profilevisit";
      page.navLog.push("click:/in/walled");
      return;
    }
    return origClick.call(this, opts);
  };
  try {
    const out = await enrichNavFirst(
      page,
      ["https://www.linkedin.com/in/good/", "https://www.linkedin.com/in/walled/"],
      "Jane Doe",
      { extract: fakeExtract },
    );
    assert.equal(out.stopped_reason, "risk_wall");
    assert.equal(out.profiles.length, 1); // the first profile was already collected
    assert.equal((out.profiles[0] as NavProfileLite).url, "https://www.linkedin.com/in/good/");
    // No third candidate was attempted after the wall.
    assert.equal(page.navLog.filter((l) => l.startsWith("click:")).length, 2);
  } finally {
    FakeLocator.prototype.click = origClick;
  }
});

test("nav-first: wall on goBack also stops (checked after back-navigation)", async () => {
  const page = new FakePage();
  page.anchors = [{ hrefSlug: "/in/one" }, { hrefSlug: "/in/two" }];
  const origGoBack = page.goBack.bind(page);
  let backCount = 0;
  page.goBack = async (opts?: { waitUntil?: string; timeout?: number }) => {
    backCount += 1;
    if (backCount >= 1) {
      page.navLog.push("goBack");
      page.currentUrl = "https://www.linkedin.com/uas/login"; // wall on the way back
      return null;
    }
    return origGoBack(opts);
  };
  const out = await enrichNavFirst(
    page,
    ["https://www.linkedin.com/in/one/", "https://www.linkedin.com/in/two/"],
    "Jane Doe",
    { extract: fakeExtract },
  );
  assert.equal(out.stopped_reason, "risk_wall");
  assert.equal(out.profiles.length, 1);
});

// ─── extraction contract ────────────────────────────────────────────────

test("nav-first: extraction stamps the navigated URL, not the input URL", async () => {
  const page = new FakePage();
  page.anchors = [{ hrefSlug: "/in/jane-doe" }];
  const seenUrls: string[] = [];
  const out = await enrichNavFirst(
    page,
    ["https://www.linkedin.com/in/jane-doe/"],
    "Jane Doe",
    {
      extract: async (_p, u) => {
        seenUrls.push(u);
        return { url: u, full_name: "Jane Doe", headline: "CEO at Acme", company: "Acme", title: "CEO", location: null };
      },
    },
  );
  // Click landed on /in/jane-doe?originalSubdomain=www → canonicalized.
  assert.deepEqual(seenUrls, ["https://www.linkedin.com/in/jane-doe"]);
  assert.equal(out.profiles.length, 1);
  assert.equal((out.profiles[0] as NavProfileLite).url, "https://www.linkedin.com/in/jane-doe");
});

test("nav-first: empty extraction (no name/headline) → parse_failed entry", async () => {
  const page = new FakePage();
  page.anchors = [{ hrefSlug: "/in/blank" }];
  const out = await enrichNavFirst(page, ["https://www.linkedin.com/in/blank/"], "Jane Doe", {
    extract: async (_p, u) => ({ url: u, full_name: null, headline: null, company: null, title: null, location: null }),
  });
  assert.equal(out.profiles.length, 1);
  assert.deepEqual(out.profiles[0], { url: "https://www.linkedin.com/in/blank", error: "parse_failed" });
  assert.equal(out.stopped_reason, null);
});
