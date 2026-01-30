export function buildTransactionHistoryInclude(includeHistory: boolean) {
	return {
		orderBy: { createdAt: 'desc' as const },
		take: includeHistory ? undefined : 0,
	};
}
