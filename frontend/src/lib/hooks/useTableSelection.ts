import { useCallback, useMemo, useState } from 'react';

/** Max rows per bulk action (visible-page selection). */
export const BULK_ACTION_MAX_ITEMS = 50;

function pruneSelection(selected: Set<string>, visibleRowIds: string[]): Set<string> {
  if (selected.size === 0) return selected;
  const visible = new Set(visibleRowIds);
  const next = new Set<string>();
  for (const id of selected) {
    if (visible.has(id)) next.add(id);
  }
  return next;
}

/**
 * Selection state for admin tables. "Select all" applies to `visibleRowIds` only.
 * Selected ids outside the visible set are ignored until the row is visible again.
 */
export function useTableSelection(visibleRowIds: string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const effectiveSelectedIds = useMemo(
    () => pruneSelection(selectedIds, visibleRowIds),
    [selectedIds, visibleRowIds],
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const allSelected =
    visibleRowIds.length > 0 && visibleRowIds.every((id) => effectiveSelectedIds.has(id));
  const someSelected = effectiveSelectedIds.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const current = pruneSelection(prev, visibleRowIds);
      const everySelected =
        visibleRowIds.length > 0 && visibleRowIds.every((id) => current.has(id));
      return everySelected ? new Set() : new Set(visibleRowIds);
    });
  }, [visibleRowIds]);

  const toggleRow = useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const current = pruneSelection(prev, visibleRowIds);
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [visibleRowIds],
  );

  const isSelected = useCallback(
    (id: string) => effectiveSelectedIds.has(id),
    [effectiveSelectedIds],
  );

  const setSelectionToIds = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  return {
    selectedIds: effectiveSelectedIds,
    selectedCount: effectiveSelectedIds.size,
    clearSelection,
    allSelected,
    someSelected,
    toggleAll,
    toggleRow,
    isSelected,
    setSelectionToIds,
  };
}

export type BulkSequentialResult = {
  succeeded: number;
  failed: number;
  failedIds: string[];
  skippedLimit: boolean;
};

/** Run one async action per id, sequentially, so bulk client fan-out cannot overwhelm the API. */
export async function runBulkSequential(
  ids: string[],
  runOne: (id: string) => Promise<boolean>,
  maxItems: number = BULK_ACTION_MAX_ITEMS,
): Promise<BulkSequentialResult> {
  if (ids.length > maxItems) {
    return { succeeded: 0, failed: 0, failedIds: ids, skippedLimit: true };
  }

  const failedIds: string[] = [];
  let succeeded = 0;

  for (const id of ids) {
    try {
      const ok = await runOne(id);
      if (ok) succeeded += 1;
      else failedIds.push(id);
    } catch {
      failedIds.push(id);
    }
  }

  return { succeeded, failed: failedIds.length, failedIds, skippedLimit: false };
}
