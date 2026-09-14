/** Returns the current local calendar month as YYYY-MM. */
export function getCurrentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
