# CoinRewind — Project Specs & Handoff

> Living document. Update the "Current Status" section after every work session.

## 1. Vision

Static website showing the price of a cryptocurrency **on the same month/day, year after year**, with the 1-year % change per row. Today's row shows a live price.

- **Philosophy: radical simplicity.** One page per coin, two controls (coin, date) embedded in the clickable title, one table. No charts, no accounts, no ads at launch, no feature creep.
- **Growth mechanic: shareable deep links** — `/{slug}?month=M&day=D` (e.g. "Bitcoin every April 15"). OG meta tags pre-rendered per coin page.
- Audience: crypto-curious general public. Viral hook: "what was BTC worth on your birthday?"
- Language: English only. Currency: USD only.

## 2. Product Decisions (locked — don't relitigate)

- Default view: Bitcoin, today's date.
- 20 coins (`data/coins.json`), expandable to 50 by adding config entries + one backfill run.
- No stablecoins (USDT/USDC — boring), no wrapped tokens (WBTC — duplicate).
- Feb 29 → falls back to Feb 28 on non-leap years, with a UI note.
- Dark mode by default; accent color per coin (`color` in coins.json).
- The h1 title IS the control panel: clickable coin name + clickable date open custom dropdown panels. No header selects.
- Prices = daily **UTC closes** (consistency across years).
- Live price badge (● LIVE) on the current-year row **only when viewing today's date**; poll every 30s, pause when tab hidden.

## 3. Architecture

- **Astro 5**, `output: 'static'`, vanilla JS only (no framework runtime shipped). Site URL: `https://coinrewind.io`.
- **Historical data**: CoinGecko Demo plan (`/coins/{id}/market_chart/range`, daily closes). Existing JSON files are the **frozen historical base** (originally backfilled from CryptoCompare) — the script only extends them forward.
- **Pre-generated JSON** committed to the repo; GitHub Actions refresh it on a schedule; Cloudflare Pages rebuilds on every push.
- **Live price**: CoinGecko keyless `/simple/price` (chosen because it's CORS-friendly and its rate limit is per-visitor IP → scales for free).
- **Hosting**: Cloudflare Pages (build: `npm run build`, output: `dist`) + domain `coinrewind.io` (Cloudflare Registrar). Cookieless Cloudflare Web Analytics enabled.
- **Secrets**: `COINGECKO_API_KEY` lives in GitHub Actions secrets only. Never in client code.

## 4. Data Pipeline

`scripts/fetch-data.mjs` (Node 20+, zero dependencies, `--env-file=.env` locally):

- **No full backfill**: the CoinGecko Demo plan caps history at ~365 days, so a missing JSON file is unrecoverable (restore from git history). The committed files are the frozen base.
- `--coin BTC`: single coin.
- `--spot`: today's price for ALL 20 coins in **1 API call** (`simple/price` with all `cgId`s), used by the daily cron.
- Incremental mode (monthly cron): fetches only missing days per coin via `market_chart/range` (~20 calls). Fails loudly if a coin's gap exceeds 360 days.

**JSON format** — `public/data/prices/{slug}.json`:
```json
{ "slug": "bitcoin", "symbol": "BTC", "name": "Bitcoin", "color": "#F7931A",
  "currency": "USD", "updatedAt": "...", "prices": [[dayEpoch, closeUsd], ...] }
```
`dayEpoch = unix_seconds / 86400`. Compact on purpose (~120 KB for BTC).

**GitHub Actions** (`.github/workflows/`):
- `daily-spot.yml` — cron `5 4 * * *`, runs `--spot`, commits if changed. (1 call/day)
- `monthly-history.yml` — cron `15 4 1 * *`, full incremental run. (20 calls/month)
- Both have `workflow_dispatch` for manual runs. Bot commits trigger a Cloudflare Pages rebuild automatically.

## 5. API Constraints (critical — verified, don't trust older sources)

- **CoinGecko Demo (free) plan = 100 calls/MINUTE** → no monthly quota anxiety. 700 ms delay between calls, short waits (Retry-After or 10 s) ×3 on HTTP 429.
- **CoinGecko Demo: only ~365 days of history** → full backfills are IMPOSSIBLE. The committed JSON files are the frozen historical base (originally from CryptoCompare); never delete them. Incremental refresh fails loudly if a coin's gap exceeds 360 days.
- `market_chart/range` returns hourly points for ranges < 90 days, daily beyond → the script collapses to one close per UTC day by keeping the LAST point of each day.
- CoinGecko daily closes may differ slightly (a few %) from the old CryptoCompare ones → `changePct` at the seam between frozen and fresh data can jump slightly. Cosmetic, accepted.
- **Coinbase & Kraken REST APIs: CORS-blocked from browsers.** Coinbase Exchange & Kraken WebSockets are NOT CORS-blocked (candidate for a future true-tick live upgrade).
- **Binance API: geo-blocked from Canada** (HTTP 451) — never use for this project.
- CoinGecko free-tier prices refresh server-side only every ~1–5 min; client fetch uses `cache: 'no-store'`; 30 s poll interval is intentional (faster polling yields nothing).

## 6. Code Conventions

- `src/lib/prices.js` is shared build-time + browser. Single source of truth for: `epochDayFor` (Feb 29 clamp), `buildYearlyRows` (descending years, skips missing years, `changePct` vs previous year, oldest row `null`), `formatPrice` (adaptive: `$115,230` / `$3.42` / `$0.00000294`), `formatChange` (integer when |pct| ≥ 100; ▲▼ arrows + color for colorblind safety), `punchlineText` (`$0.05 → $63,817 in 16 years — ×1,119,595 (+111,959,449%)`).
- All date math in UTC.
- `data/coins.json` fields: `slug`, `symbol` (display + `--coin` flag), `name`, `color`, `cgId` (CoinGecko ID — NOT the symbol: `ripple`, `binancecoin`, `avalanche-2`, `near`, `hedera-hashgraph`...). All API calls go through `cgId`.

## 7. File Structure

```
coinrewind/
├── .env (gitignored — CryptoCompare key)
├── astro.config.mjs
├── data/coins.json               ← coin config (build + fetch script)
├── public/data/prices/*.json     ← 20 datasets (served to browser AND read at build)
├── scripts/fetch-data.mjs        ← backfill / --coin / --spot
├── src/
│   ├── lib/prices.js             ← shared logic
│   ├── components/CoinPage.astro ← THE page (used by both routes below)
│   ├── pages/[slug].astro        ← 20 static pages via getStaticPaths
│   ├── pages/index.astro         ← renders CoinPage with Bitcoin directly
│   │                              (NO redirect — a redirect page got browser-cached
│   │                               and broke the live badge on "/")
│   └── styles/global.css         ← dark theme, --accent custom property
└── .github/workflows/            ← daily-spot.yml, monthly-history.yml
```

## 8. Lessons Learned / Pitfalls (do not reintroduce)

1. **PEPE symbol recycling (CryptoCompare-era, now moot)**: CryptoCompare's `PEPE` returned pre-2023 history from an older token. Real PEPE launched 2023-04-17 → dataset truncated at that date. CoinGecko uses stable IDs (`cgId`), so this class of bug is gone — but the frozen JSON files still carry that history.
2. **CSS specificity**: `#id` display rules beat `.panel[hidden]` → use `.panel[hidden] { display: none !important; }`.
3. **Astro/JSX trims whitespace** containing newlines → use `{' '}` between inline elements in the h1.
4. **argv bug (fixed)**: `process.argv[indexOf('--coin')+1]` reads `argv[0]` when flag absent → guard with `indexOf !== -1`.
5. **Astro dev caches**: after editing `data/coins.json`, restart the dev server + hard-refresh before concluding anything (a stale embedded `cgId` cost a debug session).
6. First backfill attempt burned ~42 API calls on a runaway pagination loop → always verify quota cost before running fetch scripts. (CryptoCompare-era; CoinGecko's 100/min makes this far less dangerous.)

## 9. Current Status

**Done:** data pipeline (fetch script, 20 clean datasets back to each coin's genesis), Astro frontend (pre-rendered table, clickable title panels, date/coin switching, URL state, live price w/ badge + flash, punchline, mobile responsive, Feb 29 note), spec doc. **Migrated `scripts/fetch-data.mjs` from CryptoCompare to CoinGecko Demo** (option B: existing JSON = frozen historical base, script only extends forward; spot + incremental only, no backfill possible). NOT yet tested against the real API — needs `COINGECKO_API_KEY` in `.env`.

**In progress — Step 3, deployment** (instructions already given to owner):
1. Buy `coinrewind.io` (Cloudflare Registrar) — *pending*
2. GitHub repo `coinrewind` (public), secret `COINGECKO_API_KEY` — *pending* (rename from `CRYPTOCOMPARE_API_KEY`)
3. Cloudflare Pages connect + custom domain + Web Analytics — *pending*
4. Workflow files written; verify the daily cron runs + commits + rebuilds.
5. **Test the migrated fetch script for real**: add `COINGECKO_API_KEY` to `.env`, run `--spot` then `--coin BTC`, compare a few closes against the frozen values.

## 10. Roadmap (priority order)

1. **Finish deployment** (step 3 above).
2. **Polish (step 2d)**: share button (Web Share API w/ copy-link fallback), favicon, per-coin OG image, "Try your birthday 🎂" nudge in the date panel. Optional: light-mode toggle.
3. **Expand to 50 coins**: NOT possible with CoinGecko Demo alone (no backfill beyond 365 days). Requires either a paid CoinGecko plan, a one-time CryptoCompare backfill per new coin, or accepting 1-year-only history for new coins.
4. **Optional live upgrade**: WebSocket (Coinbase Exchange `ws-feed` or Kraken v2) for true tick-by-tick; not CORS-blocked. Only if CoinGecko's 1–5 min refresh feels too slow in practice.
5. **Monetization (phase 2, only after real traffic)**: discreet affiliate footer ("Tools I use": Ledger ~10%, Coinbase/Kraken referrals) with legal disclosure. NO display ads below ~50k visits/mo — they'd kill the clean design that is the product's edge.

## 11. Working With an AI Assistant on This Project

- Paste this document + only the file(s) relevant to the task. Never the whole codebase.
- Respect the "locked" decisions (section 2) and the quota limits (section 5) in any proposal.
- After each session: update section 9.
