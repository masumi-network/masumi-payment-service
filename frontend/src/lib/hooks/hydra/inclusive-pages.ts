/**
 * Pages from an inclusive cursor, joined back into one list.
 *
 * The API repeats the cursor row as the first row of the next page, so pages
 * overlap by one and the joined list is deduped by id. Only a full page can be
 * followed by more: a short one means the end was reached.
 */

export function joinInclusivePages<T extends { id: string }>(
  pages: readonly (readonly T[])[],
): T[] {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const page of pages) {
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

export function nextInclusiveCursor<T extends { id: string }>(
  lastPage: readonly T[],
  pageSize: number,
): string | undefined {
  return lastPage.length === pageSize ? lastPage[lastPage.length - 1]?.id : undefined;
}
