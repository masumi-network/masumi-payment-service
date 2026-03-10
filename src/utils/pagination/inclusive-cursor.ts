export type InclusiveCursorItem = {
	id: string;
};

export function getInclusiveCursorId<T extends InclusiveCursorItem>(items: readonly T[]): string | undefined {
	return items[items.length - 1]?.id;
}

export function appendInclusiveCursorItems<T extends InclusiveCursorItem>(
	existingItems: readonly T[],
	nextPageItems: readonly T[],
): T[] {
	const seenIds = new Set(existingItems.map((item) => item.id));
	const mergedItems = [...existingItems];

	for (const item of nextPageItems) {
		if (seenIds.has(item.id)) {
			continue;
		}

		seenIds.add(item.id);
		mergedItems.push(item);
	}

	return mergedItems;
}
