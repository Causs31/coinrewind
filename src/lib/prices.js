// Shared date/price logic. Used at build time (Astro) and in the browser.

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MS_PER_DAY = 86_400_000;

/** epochDayFor(2023, 2, 29) -> Feb 28 2023 (clamps non-leap years). */
export function epochDayFor(year, month, day) {
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.floor(Date.UTC(year, month - 1, Math.min(day, maxDay)) / MS_PER_DAY);
}

export const dayEpochToDate = (dayEpoch) => new Date(dayEpoch * MS_PER_DAY);

export function formatDate(dayEpoch) {
  const d = dayEpochToDate(dayEpoch);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Builds the year-by-year rows for a given month/day, newest first.
 * Years with no data (e.g. chosen date is in the future this year) are skipped.
 * Each row gets `changePct` vs the previous year (null for the oldest row).
 */
export function buildYearlyRows(prices, month, day) {
  const map = new Map(prices);
  const firstYear = dayEpochToDate(prices[0][0]).getUTCFullYear();
  const currentYear = new Date().getFullYear();

  const rows = [];
  for (let year = currentYear; year >= firstYear; year--) {
    const dayEpoch = epochDayFor(year, month, day);
    const price = map.get(dayEpoch);
    if (price !== undefined) rows.push({ year, dayEpoch, price });
  }
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i + 1]; // next row = one year older
    rows[i].changePct = prev ? ((rows[i].price - prev.price) / prev.price) * 100 : null;
  }
  return rows;
}

/** Adaptive price formatting: $115,230 · $3.42 · $0.00000294 */
export function formatPrice(p) {
  if (p >= 1000) return '$' + Math.round(p).toLocaleString('en-US');
  if (p >= 1) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 0.01) return '$' + p.toFixed(4);
  return '$' + p.toPrecision(3);
}

/** "+78%" / "-3.4%" — integer when |pct| >= 100 */
export function formatChange(pct) {
  if (pct === null) return null;
  const rounded = Math.abs(pct) >= 100 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return {
    text: (rounded > 0 ? '+' : '') + rounded + '%',
    dir: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat',
  };
}

/** Growth multiple + total % between oldest and newest row. */
export function formatMultiple(rows) {
  if (rows.length < 2) return null;
  const newest = rows[0].price;
  const oldest = rows.at(-1).price;
  const mult = newest / oldest;
  const rounded = mult >= 100 ? Math.round(mult).toLocaleString('en-US') : Math.round(mult * 10) / 10;
  const pct = ((newest - oldest) / oldest) * 100;
  return {
    text: '×' + rounded,
    pctText: (pct >= 0 ? '+' : '') + Math.round(pct).toLocaleString('en-US') + '%',
    years: rows[0].year - rows.at(-1).year,
    oldest,
    newest,
  };
}

/** "$0.0570 → $63,817 in 16 years — ×1,119,595 (+111,959,449%)" */
export function punchlineText(rows) {
  const mult = formatMultiple(rows);
  if (!mult) return 'Not enough history yet';
  return `${formatPrice(mult.oldest)} → ${formatPrice(mult.newest)} in ${mult.years} years — ${mult.text} (${mult.pctText})`;
}
