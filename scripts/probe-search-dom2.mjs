// DOM probe (self-contained): dump actual LinkedIn flagship search card structure.
// Exists because pages/api/lookup.ts selectors (.entity-result__primary-subtitle)
// return null on the live DOM — we need ground truth before finalizing selectors.
//
// Self-contained: does NOT import @/lib (only resolves under Next's bundler).
// Replicates lib/linkedin/session.ts fingerprint exactly:
//   - storage decrypt "v1:<iv>:<tag>:<data>" = AES-256-GCM, key = hkdf-sha256(
//     NEXTAUTH_SECRET, salt="", info="linki-secret-encryption", 32)
//   - context: UA Chrome/131, viewport 1920x1080, locale en-US, tz America/New_York
//
// Usage: node scripts/probe-search-dom2.mjs "Search Keywords" [outFile]
// Run from ~/Developer/linki. Read-only: one search page load, no clicks, no writes.
// IMPORTANT: strip debug output below 120KB before reading the file back.

import Database from "better-sqlite3";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { hkdfSync, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

chromium.use(StealthPlugin());

const keywords = process.argv[2] || "Isaac Meek";
const outFile = process.argv[3] || "/tmp/dom-probe.json";

const ACCOUNT_ID = "31f93886-a209-4312-a56e-f090a01fca2e";
const DB_PATH = process.env.LINKI_DB_PATH || path.join(process.cwd(), "linki.db");
const SEARCH_URL = (kw) =>
  `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(kw)}&origin=GLOBAL_SEARCH_HEADER`;

function decryptSecret(value) {
  if (!value.startsWith("v1:")) return value; // plaintext passthrough
  const [, ivB64, tagB64, dataB64] = value.split(":");
  const key = Buffer.from(
    hkdfSync("sha256", process.env.NEXTAUTH_SECRET, "", "linki-secret-encryption", 32)
  );
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(dataB64, "base64")), d.final()]).toString("utf8");
}

// --- env: load NEXTAUTH_SECRET from .env.local (probe runs outside Next) ---
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const db = new Database(DB_PATH, { readonly: true });
const account = db
  .prepare("SELECT id, cookies_json FROM accounts WHERE id = ? AND is_authenticated = 1")
  .get(ACCOUNT_ID);
if (!account?.cookies_json) {
  fs.writeFileSync(outFile, JSON.stringify({ error: "no authenticated account or no cookies_json" }));
  console.error("no authenticated account");
  process.exit(1);
}

let storageState;
try {
  storageState = JSON.parse(decryptSecret(account.cookies_json));
} catch (e) {
  fs.writeFileSync(outFile, JSON.stringify({ error: "decrypt/parse failed: " + e.message }));
  process.exit(1);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});
const ctx = await browser.newContext({
  storageState,
  viewport: { width: 1920, height: 1080 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "en-US",
  timezoneId: "America/New_York",
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();
try {
  await page.goto(SEARCH_URL(keywords), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  try {
    await page.waitForSelector("li.reusable-search__result-container, .entity-result", { timeout: 10000 });
  } catch {}

  const dump = await page.evaluate(() => {
    const out = { url: location.href, counts: {}, cards: [] };
    // Prefer structured probes over raw HTML (raw HTML overflows tool output).
    // Walk UP from /in/ anchors to find the real card container.
    const seen = new Set();
    const cards = [];
    for (const a of [...document.querySelectorAll('a[href*="/in/"]')]) {
      const href = (a.getAttribute("href") || "").split("?")[0];
      if (!/^https?:\/\/www\.linkedin\.com\/in\/[^/]+\/?$/.test(href)) continue;
      let card = a.closest("li") || a.closest("div[data-view-name]") || a.parentElement?.parentElement?.parentElement;
      let hops = 0;
      while (card && card !== document.body && hops < 6) {
        const txt = (card.innerText || "").trim();
        if (txt.length > 40 && card.querySelectorAll("a").length >= 1) break;
        card = card.parentElement; hops++;
      }
      if (!card || seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }
    for (const card of cards.slice(0, 3)) {
      out.cards.push({
        // class inventory of the card's first ~40 elements — enough to spot
        // the real subtitle containers without dumping megabytes of markup.
        cardTag: card.tagName,
        cardClass: (card.className || "").toString().slice(0, 200),
        childTree: [...card.querySelectorAll("*")].slice(0, 50).map((e) => ({
          tag: e.tagName,
          cls: (typeof e.className === "string" ? e.className : "").slice(0, 120),
          aria: e.getAttribute("aria-hidden"),
          txt: (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
        })).filter((e) => e.cls || e.txt),
        titleText: card.querySelector(".entity-result__title-text")?.textContent?.trim() ?? null,
        titleAnchorHref: card.querySelector(".entity-result__title-text a")?.getAttribute("href") ?? null,
        primarySubtitle: card.querySelector(".entity-result__primary-subtitle")?.textContent?.trim() ?? null,
        secondarySubtitle: card.querySelector(".entity-result__secondary-subtitle")?.textContent?.trim() ?? null,
        sublines: [...card.querySelectorAll(".t-14, .t-normal, .t-black--light")].map((e) =>
          (e.textContent || "").trim().replace(/\s+/g, " ")
        ).filter(Boolean).slice(0, 8),
        ariaHiddenSpans: [...card.querySelectorAll("span[aria-hidden=true]")]
          .map((e) => e.textContent?.trim()).filter(Boolean).slice(0, 6),
        dataFields: [...card.querySelectorAll("[data-field]")].map((e) => ({
          f: e.getAttribute("data-field"),
          t: (e.textContent || "").trim().slice(0, 100),
        })),
        fullTextLines: (card.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12),
      });
    }
    out.counts = {
      primarySubtitle: document.querySelectorAll(".entity-result__primary-subtitle").length,
      secondarySubtitle: document.querySelectorAll(".entity-result__secondary-subtitle").length,
      reusableContainers: document.querySelectorAll("li.reusable-search__result-container").length,
      entityResults: document.querySelectorAll(".entity-result").length,
      inAnchors: document.querySelectorAll('a[href*="/in/"]').length,
      viewNames: [...new Set([...document.querySelectorAll("[data-view-name]")].map((e) => e.getAttribute("data-view-name")))],
    };
    return out;
  });

  fs.writeFileSync(outFile, JSON.stringify(dump, null, 1));
  console.log("WROTE", outFile, "cards:", dump.cards.length);
} finally {
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
}
