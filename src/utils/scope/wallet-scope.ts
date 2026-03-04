import createHttpError from 'http-errors';

/**
 * For write operations: throws 403 if hotWalletId is not in the key's scope.
 * No-op for unscoped keys (null hotWalletIds = access all).
 */
export function assertHotWalletInScope(hotWalletId: string, hotWalletIds: string[] | null): void {
	if (hotWalletIds === null) return;
	if (!hotWalletIds.includes(hotWalletId)) {
		throw createHttpError(403, 'Forbidden: wallet not in API key scope');
	}
}

/**
 * Spreads into a HotWallet WHERE object for direct wallet queries (wallet endpoint GET).
 * Returns { id: { in: hotWalletIds } } or undefined when unscoped.
 * Safe to spread: { ...getHotWalletIdFilter(ctx.hotWalletIds), type: ..., deletedAt: null }
 */
export function getHotWalletIdFilter(hotWalletIds: string[] | null): { id: { in: string[] } } | undefined {
	if (hotWalletIds === null) return undefined;
	return { id: { in: hotWalletIds } };
}

/**
 * Spreads at the PaymentRequest/RegistryRequest WHERE level — adds a SmartContractWallet condition.
 * Use when the query does NOT already have a SmartContractWallet in its where clause.
 * Returns { SmartContractWallet: { id: { in: hotWalletIds } } } or undefined when unscoped.
 */
export function getSmartContractWalletScopeCondition(
	hotWalletIds: string[] | null,
): { SmartContractWallet: { id: { in: string[] } } } | undefined {
	if (hotWalletIds === null) return undefined;
	return { SmartContractWallet: { id: { in: hotWalletIds } } };
}

/**
 * Spreads INSIDE an existing SmartContractWallet: { ... } object.
 * Use when the query already has SmartContractWallet: { deletedAt: null } and you need to add the id filter.
 * Returns { id: { in: hotWalletIds } } or {} when unscoped.
 */
export function getSmartContractWalletIdFilter(
	hotWalletIds: string[] | null,
): { id: { in: string[] } } | Record<string, never> {
	if (hotWalletIds === null) return {};
	return { id: { in: hotWalletIds } };
}

/**
 * Spreads into a PaymentSource WHERE object — filters to sources that contain at least one scoped wallet.
 * Use for: purchases GET, payment-source GET, rpc-api-keys, webhooks.
 * Returns { HotWallets: { some: { id: { in: hotWalletIds }, deletedAt: null } } } or undefined when unscoped.
 */
export function getPaymentSourceHasWalletFilter(
	hotWalletIds: string[] | null,
): { HotWallets: { some: { id: { in: string[] }; deletedAt: null } } } | undefined {
	if (hotWalletIds === null) return undefined;
	return { HotWallets: { some: { id: { in: hotWalletIds }, deletedAt: null } } };
}
