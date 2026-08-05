#!/usr/bin/env node
/**
 * Fetches daily USD price history from CoinGecko for each coin
 * in data/coins.json and writes compact JSON to public/data/prices/<slug>.json
 *
 * Price format: [dayEpoch, closeUsd] where dayEpoch = unix_seconds / 86400
 *
 * IMPORTANT — CoinGecko Demo (free) plan limits history to the last 365 days.
 * Existing JSON files are the frozen historical base (backfilled from
 * CryptoCompare); this script only extends them forward. A full backfill of
 * a brand-new coin is NOT possible on the free plan.
 *
 * Usage:
 *   node --env-file=.env scripts/fetch-data.mjs              monthly refresh (incremental, ~20 calls)
 *   node --env-file=.env scripts/fetch-data.mjs --coin BTC   single coin only
 *   node --env-file=.env scripts/fetch-data.mjs --spot       today's price for ALL coins in ONE call
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COINS_FILE = path.join(ROOT, 'data', 'coins.json');
const PRICES_DIR = path.join(ROOT, 'public', 'data', 'prices');

const API_BASE = 'https://api.coingecko.com/api/v3';
const API_KEY = process.env.COINGECKO_API_KEY;

const SECONDS_PER_DAY = 86400;
const MAX_HISTORY_DAYS = 360;  // Demo plan serves ~365 days of history; keep a margin
const REQUEST_DELAY_MS = 700;  // 100 calls/min ≈ 1 per 600ms; small margin
const MAX_RETRIES = 5;         // network/HTTP retries (exponential backoff)
const MAX_RATE_LIMIT_WAITS = 3; // HTTP 429: honor Retry-After / short waits
const RATE_LIMIT_WAIT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayEpochDay = () => Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
const dayToISO = (d) => new Date(d * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);

/** HTTP layer: retries, backoff, rate-limit handling. Returns parsed JSON. */
async function fetchJson(url) {
  for (let attempt = 1, rateLimitWaits = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'x-cg-demo-api-key': API_KEY },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Network error after ${MAX_RETRIES} retries: ${err.message}`);
    }

    if (res.status === 429) {
      rateLimitWaits++;
      if (rateLimitWaits <= MAX_RATE_LIMIT_WAITS) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RATE_LIMIT_WAIT_MS;
        console.log(`  Rate limited (429) — waiting ${wait / 1000}s (${rateLimitWaits}/${MAX_RATE_LIMIT_WAITS})...`);
        await sleep(wait);
        continue;
      }
      throw new Error('Still rate limited after several waits — re-run the script later');
    }
    if (res.status >= 500) {
      if (attempt <= MAX_RETRIES) {
        const wait = 1000 * 2 ** attempt;
        console.log(`  HTTP ${res.status}, retrying in ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    return res.json();
  }
}

/**
 * market_chart/range returns { prices: [[msTimestamp, price], ...] }.
 * Points are hourly for ranges < 90 days, daily beyond. Collapse to one
 * close per UTC day by keeping the LAST point of each day.
 */
function toEntries(prices) {
  const byDay = new Map();
  for (const p of prices) {
    const [ms, price] = p;
    if (typeof ms === 'number' && typeof price === 'number' && price > 0) {
      byDay.set(Math.floor(ms / 1000 / SECONDS_PER_DAY), price); // later points overwrite
    }
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]);
}

/** Fetch daily closes from `fromDay` (epoch day, inclusive) up to now. */
async function fetchRange(cgId, fromDay) {
  const from = fromDay * SECONDS_PER_DAY;
  const to = Math.floor(Date.now() / 1000);
  const json = await fetchJson(
    `${API_BASE}/coins/${cgId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`
  );
  if (!Array.isArray(json?.prices)) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return toEntries(json.prices);
}

/**
 * Daily update: ONE simple/price call returns the current price of every coin.
 * Stored as today's data point (fallback for the live price on the site).
 * Cost: 1 API call for all 20 coins.
 */
async function updateSpotPrices(coins) {
  const ids = coins.map((c) => c.cgId).join(',');
  const json = await fetchJson(`${API_BASE}/simple/price?ids=${ids}&vs_currencies=usd`);
  const today = todayEpochDay();
  let updated = 0;

  for (const coin of coins) {
    const price = json?.[coin.cgId]?.usd;
    if (typeof price !== 'number' || price <= 0) {
      console.log(`  ${coin.symbol}: no spot price returned, skipping`);
      continue;
    }
    const existing = await loadExisting(coin.slug);
    if (!existing?.prices?.length) {
      console.log(`  ${coin.symbol}: no local file yet (run the backfill first), skipping`);
      continue;
    }
    const map = new Map(existing.prices);
    map.set(today, price);
    existing.prices = [...map.entries()].sort((a, b) => a[0] - b[0]);
    existing.updatedAt = new Date().toISOString();
    await writeFile(path.join(PRICES_DIR, `${coin.slug}.json`), JSON.stringify(existing));
    console.log(`  ${coin.symbol}: $${price}`);
    updated++;
  }
  console.log(`\nSpot prices updated for ${updated}/${coins.length} coins — cost: 1 API call.`);
}

async function loadExisting(slug) {
  try {
    return JSON.parse(await readFile(path.join(PRICES_DIR, `${slug}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function saveCoin(coin, prices) {
  const out = {
    slug: coin.slug,
    symbol: coin.symbol,
    name: coin.name,
    color: coin.color,
    currency: 'USD',
    updatedAt: new Date().toISOString(),
    prices,
  };
  await writeFile(path.join(PRICES_DIR, `${coin.slug}.json`), JSON.stringify(out));
}

async function main() {
  if (!API_KEY) {
    console.error('ERROR: COINGECKO_API_KEY is missing. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const isSpot = process.argv.includes('--spot');
  const coinIndex = process.argv.indexOf('--coin');
  const onlyCoin = coinIndex !== -1 ? process.argv[coinIndex + 1]?.toUpperCase() : null;

  const allCoins = JSON.parse(await readFile(COINS_FILE, 'utf8'));
  const coins = onlyCoin ? allCoins.filter((c) => c.symbol === onlyCoin) : allCoins;
  if (!coins.length) {
    console.error(`No coin matches --coin ${onlyCoin}`);
    process.exit(1);
  }

  await mkdir(PRICES_DIR, { recursive: true });

  if (isSpot) {
    await updateSpotPrices(coins);
    return;
  }

  const report = [];
  for (const coin of coins) {
    console.log(`\n${coin.name} (${coin.symbol})`);
    try {
      const existing = await loadExisting(coin.slug);

      if (!existing?.prices?.length) {
        // Option B: the frozen CryptoCompare files are the historical base.
        // The Demo plan cannot backfill more than ~365 days, so a missing
        // file is unrecoverable here.
        console.error('  FAILED: no local file — full backfill is not possible on the CoinGecko Demo plan (365-day limit). Restore public/data/prices/' + coin.slug + '.json from git history.');
        report.push({ coin: coin.symbol, status: 'ERROR', error: 'no local file, backfill impossible' });
        continue;
      }

      const lastDay = existing.prices.at(-1)[0];
      const gap = todayEpochDay() - lastDay;
      if (gap <= 0) {
        console.log('  already up to date');
        report.push({ coin: coin.symbol, status: 'up-to-date', days: existing.prices.length });
        continue;
      }
      if (gap > MAX_HISTORY_DAYS) {
        console.error(`  FAILED: gap of ${gap} days exceeds the CoinGecko Demo 365-day history limit — cannot fill it.`);
        report.push({ coin: coin.symbol, status: 'ERROR', error: `gap ${gap}d > ${MAX_HISTORY_DAYS}d limit` });
        continue;
      }

      const fresh = await fetchRange(coin.cgId, lastDay - 2); // small overlap for safety
      const map = new Map(existing.prices);
      for (const e of fresh) map.set(e[0], e[1]);
      const prices = [...map.entries()].sort((a, b) => a[0] - b[0]);
      console.log(`  +${fresh.length} days (total: ${prices.length})`);

      await saveCoin(coin, prices);
      report.push({
        coin: coin.symbol,
        status: 'ok',
        days: prices.length,
        first: dayToISO(prices[0][0]),
        last: dayToISO(prices.at(-1)[0]),
      });
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      report.push({ coin: coin.symbol, status: 'ERROR', error: err.message });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log('\n--- Report ---');
  console.table(report);

  const failures = report.filter((r) => r.status === 'ERROR');
  if (failures.length === report.length) process.exit(1);
  if (failures.length) console.log(`${failures.length} coin(s) failed — re-run the script; it only fetches what's missing.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
