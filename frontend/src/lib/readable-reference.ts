/** Shorten a long internal id for display while keeping ends recognizable. */
export function shortenRecordId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/**
 * Prefer a human label when available; otherwise show a shortened id.
 * Full value should still be offered via copy where operators need it.
 */
export function formatRecordReference(id: string, label?: string | null): string {
  const trimmed = label?.trim();
  if (trimmed) return trimmed;
  return shortenRecordId(id);
}
