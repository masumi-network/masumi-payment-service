import { buildManagedHolderWalletScopeFilter } from './wallet-scope';

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
