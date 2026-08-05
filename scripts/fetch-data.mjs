#!/usr/bin/env node
/**
 * Fetches daily USD price history from CryptoCompare for each coin
 * in data/coins.json and writes compact JSON to data/prices/<slug>.json
 *
 * Price format: [dayEpoch, closeUsd] where dayEpoch = unix_seconds / 86400
 *
 * Usage:
 *   node --env-file=.env scripts/fetch-data.mjs              backfill (first run) or monthly refresh
 *   node --env-file=.env scripts/fetch-data.mjs --coin BTC   single coin only
 *   node --env-file=.env scripts/fetch-data.mjs --spot       today's price for ALL coins in ONE call
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COINS_FILE = path.join(ROOT, 'data', 'coins.json');
const PRICES_DIR = path.join(ROOT, 'public', 'data', 'prices');

const HISTORY_URL = 'https://min-api.cryptocompare.com/data/v2/histoday';
const SPOT_URL = 'https://min-api.cryptocompare.com/data/pricemulti';
const API_KEY = process.env.CRYPTOCOMPARE_API_KEY;

const PAGE_SIZE = 2000;          // API max per request (note: API returns limit+1 points)
const MAX_PAGES = 25;            // safety net against runaway pagination
const SECONDS_PER_DAY = 86400;
const REQUEST_DELAY_MS = 2000;   // conservative: free tier throttles short windows
const MAX_RETRIES = 5;           // network/HTTP retries (exponential backoff)
const MAX_RATE_LIMIT_WAITS = 2;  // long waits when the API says "rate limit"
const RATE_LIMIT_WAIT_MS = 65_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayEpochDay = () => Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
const dayToISO = (d) => new Date(d * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);

/** HTTP layer: retries, backoff, rate-limit handling. Returns parsed JSON. */
async function fetchJson(url) {
  for (let attempt = 1, rateLimitWaits = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { authorization: `Apikey ${API_KEY}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Network error after ${MAX_RETRIES} retries: ${err.message}`);
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt <= MAX_RETRIES) {
        const wait = 1000 * 2 ** attempt;
        console.log(`  HTTP ${res.status}, retrying in ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const json = await res.json();

    if (json.Response === 'Error') {
      const msg = json.Message || 'unknown error';
      if (/rate limit/i.test(msg)) {
        rateLimitWaits++;
        if (rateLimitWaits <= MAX_RATE_LIMIT_WAITS) {
          console.log(`  Rate limited — waiting 65s before retry (${rateLimitWaits}/${MAX_RATE_LIMIT_WAITS})...`);
          await sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        throw new Error('Still rate limited after two 65s waits — re-run the script later');
      }
      throw new Error(`CryptoCompare: ${msg}`);
    }
    return json;
  }
}

/** histoday call: validates the nested Data.Data shape, returns raw points. */
async function apiGetHistory(url) {
  const json = await fetchJson(url);
  const points = json?.Data?.Data;
  if (!Array.isArray(points)) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return points;
}

/** Keep only valid points, convert to [dayEpoch, close]. */
function toEntries(points) {
  const entries = [];
  for (const p of points) {
    if (typeof p.time === 'number' && typeof p.close === 'number' && p.close > 0) {
      entries.push([Math.floor(p.time / SECONDS_PER_DAY), p.close]);
    }
  }
  return entries;
}

/** First run: page backwards until a page adds no new days. */
async function fetchFullHistory(symbol) {
  const map = new Map();
  let toTs = Math.floor(Date.now() / 1000);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const points = await apiGetHistory(`${HISTORY_URL}?fsym=${symbol}&tsym=USD&limit=${PAGE_SIZE}&toTs=${toTs}`);
    const sizeBefore = map.size;
    for (const [day, close] of toEntries(points)) map.set(day, close);
    const newDays = map.size - sizeBefore;
    console.log(`  page ${page}: +${newDays} new days (total: ${map.size})`);

    if (newDays === 0) break; // beginning of available history reached
    toTs = Math.min(...points.map((p) => p.time)) - SECONDS_PER_DAY;
    await sleep(REQUEST_DELAY_MS);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

/** Monthly refresh: fetch only the days missing since the last stored day. */
async function fetchIncremental(symbol, lastStoredDay) {
  const missing = todayEpochDay() - lastStoredDay + 2; // small overlap for safety
  if (missing > PAGE_SIZE) return fetchFullHistory(symbol); // gap too big, start over
  const points = await apiGetHistory(`${HISTORY_URL}?fsym=${symbol}&tsym=USD&limit=${Math.max(missing, 1)}`);
  return toEntries(points);
}

/**
 * Daily update: ONE pricemulti call returns the current price of every coin.
 * Stored as today's data point (fallback for the live price on the site).
 * Cost: 1 API call for all 20 coins.
 */
async function updateSpotPrices(coins) {
  const fsyms = coins.map((c) => c.symbol).join(',');
  const json = await fetchJson(`${SPOT_URL}?fsyms=${fsyms}&tsyms=USD`);
  const today = todayEpochDay();
  let updated = 0;

  for (const coin of coins) {
    const price = json?.[coin.symbol]?.USD;
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
    console.error('ERROR: CRYPTOCOMPARE_API_KEY is missing. Copy .env.example to .env and fill it in.');
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
      let prices;

      if (existing?.prices?.length) {
        const lastDay = existing.prices.at(-1)[0];
        if (todayEpochDay() - lastDay <= 0) {
          console.log('  already up to date');
          report.push({ coin: coin.symbol, status: 'up-to-date', days: existing.prices.length });
          continue;
        }
        const fresh = await fetchIncremental(coin.symbol, lastDay);
        const map = new Map(existing.prices);
        for (const e of fresh) map.set(e[0], e[1]);
        prices = [...map.entries()].sort((a, b) => a[0] - b[0]);
        console.log(`  +${fresh.length} days (total: ${prices.length})`);
      } else {
        prices = await fetchFullHistory(coin.symbol);
      }

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
