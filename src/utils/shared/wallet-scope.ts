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
