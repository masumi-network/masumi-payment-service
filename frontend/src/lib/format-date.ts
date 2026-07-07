/**
 * Centralized date/time formatting so the whole app renders timestamps one way.
 *
 * - `formatDate`     — date only. Use in dense lists/tables where the day is enough.
 * - `formatDateTime` — date + time. Use in detail views and transaction rows where
 *                      the exact moment matters.
 *
 * Both accept the shapes the API and app actually hand us — ISO strings, `Date`
 * objects, and unix-epoch-millisecond values (as a number OR an all-digit string,
 * which is how some transaction timestamps arrive) — and return an em dash for
 * missing/invalid values instead of "Invalid Date".
 *
 * NOTE: intentionally does NOT cover invoice dates (rendered in UTC for the legal
 * document) or month-year pickers (custom `{ month: 'long', year: 'numeric' }`).
 * Those stay explicit at their call sites.
 */

export type DateInput = Date | string | number | null | undefined;

const EMPTY = '—';

function toDate(value: DateInput): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // All-digit string or a raw number: unix epoch milliseconds.
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d+$/.test(value)) {
    const d = new Date(parseInt(value, 10));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date only (e.g. `7/1/2026`), or `—` when missing/invalid. */
export function formatDate(value: DateInput): string {
  const d = toDate(value);
  return d ? d.toLocaleDateString() : EMPTY;
}

/** Date + time (e.g. `7/1/2026, 3:04:12 PM`), or `—` when missing/invalid. */
export function formatDateTime(value: DateInput): string {
  const d = toDate(value);
  return d ? d.toLocaleString() : EMPTY;
}
