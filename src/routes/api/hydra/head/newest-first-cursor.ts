/**
 * Newest-first keyset paging for the head lists.
 *
 * Every head list sorts on (createdAt desc, id desc). The id breaks ties, so the
 * order is total: two rows written in the same millisecond still have one fixed
 * order, and a cursor that lands on either of them resumes in the same place.
 *
 * The cursor is inclusive, as everywhere else in this API: the row it names is
 * returned again as the first row of the next page, and clients dedupe by id.
 *
 * The transactions list merges three tables. A row id cannot be fed to three
 * Prisma cursors, so it is resolved to its (createdAt, id) position once and
 * each table is read from that position with a plain where clause. Each source
 * returns its own newest `limit` rows at or after the position, so the newest
 * `limit` of their union is exactly the next page.
 */

export type NewestFirstPosition = { createdAt: Date; id: string };

export const newestFirstOrder = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/** The rows at or after `position` in newest-first order. */
export function atOrAfter(position: NewestFirstPosition) {
	return {
		OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lte: position.id } }],
	};
}

/**
 * The same order in JavaScript, for merging the three sources.
 *
 * The database compares ids by its collation and this compares them by code
 * unit. The two agree only because every id here is a cuid: lowercase letters
 * and digits of one length, which en_US.UTF-8 orders exactly as code units do.
 * An id with capitals or punctuation could sort differently in each, and a page
 * boundary on a same-millisecond tie would then skip or repeat a row.
 */
export function compareNewestFirst(left: NewestFirstPosition, right: NewestFirstPosition): number {
	const byTime = right.createdAt.getTime() - left.createdAt.getTime();
	if (byTime !== 0) return byTime;
	return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}
