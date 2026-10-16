import createHttpError from 'http-errors';

export function buildWalletScopeFilter(walletScopeIds: string[] | null) {
	if (walletScopeIds === null) return {};
	return { smartContractWalletId: { in: walletScopeIds } };
}

export function buildManagedHolderWalletScopeFilter(walletScopeIds: string[] | null) {
	if (walletScopeIds === null) return {};

	return {
		AND: [
			{
				OR: [
					{ deregistrationHotWalletId: { in: walletScopeIds } },
					{
						deregistrationHotWalletId: null,
						recipientHotWalletId: { in: walletScopeIds },
					},
					{
						deregistrationHotWalletId: null,
						recipientHotWalletId: null,
						smartContractWalletId: { in: walletScopeIds },
					},
				],
			},
		],
	};
}

export function buildHotWalletScopeFilter(walletScopeIds: string[] | null) {
	if (walletScopeIds === null) return {};
	return { id: { in: walletScopeIds } };
}

export function assertWalletInScope(walletScopeIds: string[] | null, smartContractWalletId: string | null): void {
	if (walletScopeIds === null) return;
	if (smartContractWalletId === null || !walletScopeIds.includes(smartContractWalletId)) {
		throw createHttpError(404, 'Not found');
	}
}

export function assertHotWalletInScope(walletScopeIds: string[] | null, hotWalletId: string): void {
	if (walletScopeIds === null) return;
	if (!walletScopeIds.includes(hotWalletId)) {
		throw createHttpError(404, 'Not found');
	}
}

/**
 * Whether a caller may see a purchase row it did not query through a scoped
 * list. Matches the list filter (wallet scope) and also lets the creating key
 * see its own row, so an idempotent retry still gets the stored object back,
 * also before a wallet is assigned. The creator clause is deliberately wider
 * than the other purchase read paths, which use wallet scope only.
 */
export function isRequestVisibleToCaller(
	ctx: { id: string; walletScopeIds: string[] | null },
	request: { requestedById: string; smartContractWalletId: string | null },
): boolean {
	if (ctx.walletScopeIds === null) return true;
	if (request.requestedById === ctx.id) return true;
	return request.smartContractWalletId !== null && ctx.walletScopeIds.includes(request.smartContractWalletId);
}
