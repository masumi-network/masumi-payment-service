import { describe, expect, it } from '@jest/globals';
import { assertWalletOwner, buildOwnerScopeWhere } from './internal';

const KEY = 'key_self';
const OTHER_KEY = 'key_other';

describe('buildOwnerScopeWhere', () => {
	it('does not restrict an admin', () => {
		expect(buildOwnerScopeWhere(null)).toEqual({});
		expect(buildOwnerScopeWhere({ scope: null, walletScopeIds: ['w1'] })).toEqual({});
	});

	it('restricts an unscoped key to what it created', () => {
		// walletScopeIds null is the `x402WalletScopeEnabled=false` case, which mirrors
		// the Cardano flag: the key is unscoped, so only creator ownership applies.
		expect(buildOwnerScopeWhere({ scope: KEY, walletScopeIds: null })).toEqual({ createdById: KEY });
		expect(buildOwnerScopeWhere(KEY)).toEqual({ createdById: KEY });
	});

	it('unions assigned wallets with the ones the key created', () => {
		expect(buildOwnerScopeWhere({ scope: KEY, walletScopeIds: ['w1', 'w2'] })).toEqual({
			OR: [{ createdById: KEY }, { id: { in: ['w1', 'w2'] } }],
		});
	});

	it('still matches own wallets when the assigned list is empty', () => {
		expect(buildOwnerScopeWhere({ scope: KEY, walletScopeIds: [] })).toEqual({
			OR: [{ createdById: KEY }, { id: { in: [] } }],
		});
	});
});

describe('assertWalletOwner', () => {
	const owned = { id: 'w_own', createdById: KEY };
	const foreign = { id: 'w_foreign', createdById: OTHER_KEY };

	it('lets an admin through', () => {
		expect(() => assertWalletOwner(null, foreign)).not.toThrow();
	});

	it('lets a key reach a wallet it created', () => {
		expect(() => assertWalletOwner({ scope: KEY, walletScopeIds: [] }, owned)).not.toThrow();
	});

	it('lets a key reach a wallet assigned to it', () => {
		expect(() => assertWalletOwner({ scope: KEY, walletScopeIds: ['w_foreign'] }, foreign)).not.toThrow();
	});

	it('rejects a wallet that is neither created nor assigned', () => {
		expect(() => assertWalletOwner({ scope: KEY, walletScopeIds: ['w_something_else'] }, foreign)).toThrow(
			'Managed EVM wallet not found',
		);
	});

	it('rejects with 404 rather than 403 so absence and no-access look identical', () => {
		try {
			assertWalletOwner({ scope: KEY, walletScopeIds: null }, foreign);
			throw new Error('expected a throw');
		} catch (error) {
			expect((error as { status?: number }).status).toBe(404);
		}
	});

	it('keeps creator access when the key is scoped, so a freshly created wallet stays visible', () => {
		// A scoped key that creates a wallet is not in its own assignment list, so
		// without the union the wallet would vanish the instant it was created.
		expect(() => assertWalletOwner({ scope: KEY, walletScopeIds: ['w_unrelated'] }, owned)).not.toThrow();
	});
});
