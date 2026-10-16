import { buildManagedHolderWalletScopeFilter, isRequestVisibleToCaller } from './wallet-scope';

describe('buildManagedHolderWalletScopeFilter', () => {
	it('returns an empty filter when wallet scope is disabled', () => {
		expect(buildManagedHolderWalletScopeFilter(null)).toEqual({});
	});

	it('matches the current managed holder wallet in deregistration, recipient, and minting fallback order', () => {
		expect(buildManagedHolderWalletScopeFilter(['wallet-a', 'wallet-b'])).toEqual({
			AND: [
				{
					OR: [
						{ deregistrationHotWalletId: { in: ['wallet-a', 'wallet-b'] } },
						{
							deregistrationHotWalletId: null,
							recipientHotWalletId: { in: ['wallet-a', 'wallet-b'] },
						},
						{
							deregistrationHotWalletId: null,
							recipientHotWalletId: null,
							smartContractWalletId: { in: ['wallet-a', 'wallet-b'] },
						},
					],
				},
			],
		});
	});
});

describe('isRequestVisibleToCaller', () => {
	const request = { requestedById: 'key-owner', smartContractWalletId: 'wallet-a' };

	it('shows every request when wallet scope is disabled', () => {
		expect(isRequestVisibleToCaller({ id: 'key-other', walletScopeIds: null }, request)).toBe(true);
	});

	it('shows a request whose wallet is in scope', () => {
		expect(isRequestVisibleToCaller({ id: 'key-other', walletScopeIds: ['wallet-a'] }, request)).toBe(true);
	});

	it('shows a request to the key that created it', () => {
		expect(isRequestVisibleToCaller({ id: 'key-owner', walletScopeIds: [] }, request)).toBe(true);
	});

	it('hides a request outside the scope from another key', () => {
		expect(isRequestVisibleToCaller({ id: 'key-other', walletScopeIds: ['wallet-b'] }, request)).toBe(false);
	});

	it('hides a request with no wallet yet from another scoped key', () => {
		expect(
			isRequestVisibleToCaller(
				{ id: 'key-other', walletScopeIds: ['wallet-a'] },
				{ requestedById: 'key-owner', smartContractWalletId: null },
			),
		).toBe(false);
	});
});
