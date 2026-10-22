import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type WalletRow = {
	id: string;
	deletedAt: Date | null;
	pendingTransactionId: string | null;
	pendingSwapTransactionId: string | null;
	lockedAt: Date | null;
	lockPurpose: string | null;
};

type LockedAtFilter = null | { lt: Date };
type WalletWhere = Partial<Omit<WalletRow, 'lockedAt'>> & { OR?: Array<{ lockedAt: LockedAtFilter }> };

// One wallet row, and an `updateMany` that applies the same filter Postgres
// would. Enough to replay a claim, a takeover and a late release in order.
let wallet: WalletRow;

function matches(row: WalletRow, where: WalletWhere): boolean {
	const { OR, ...equalities } = where;
	for (const [key, value] of Object.entries(equalities)) {
		if (row[key as keyof WalletRow] !== value) return false;
	}
	if (!OR) return true;
	return OR.some(({ lockedAt }) =>
		lockedAt === null ? row.lockedAt === null : row.lockedAt !== null && row.lockedAt < lockedAt.lt,
	);
}

const updateMany = jest.fn(async ({ where, data }: { where: WalletWhere; data: Partial<WalletRow> }) => {
	if (!matches(wallet, where)) return { count: 0 };
	wallet = { ...wallet, ...data };
	return { count: 1 };
});

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hotWallet: { updateMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { error: jest.fn() },
}));

let claimHotWalletForL1: typeof import('./index').claimHotWalletForL1;
let releaseHotWalletAfterL1: typeof import('./index').releaseHotWalletAfterL1;
let HOT_WALLET_LOCK_STALE_AFTER_MS: number;

beforeAll(async () => {
	({ claimHotWalletForL1, releaseHotWalletAfterL1, HOT_WALLET_LOCK_STALE_AFTER_MS } = await import('./index'));
});

beforeEach(() => {
	wallet = {
		id: 'wallet-1',
		deletedAt: null,
		pendingTransactionId: null,
		pendingSwapTransactionId: null,
		lockedAt: null,
		lockPurpose: null,
	};
});

describe('Hydra L1 wallet claim', () => {
	it('keeps a newer claim when the stale claim it took over is released late', async () => {
		const staleToken = await claimHotWalletForL1('wallet-1', 'top-up');
		wallet = { ...wallet, lockedAt: new Date(Date.now() - HOT_WALLET_LOCK_STALE_AFTER_MS - 1) };
		const newerToken = await claimHotWalletForL1('wallet-1', 'commit');

		// The first operation's reconciler lands after the takeover.
		await releaseHotWalletAfterL1('wallet-1', staleToken);
		expect(wallet.lockedAt).not.toBeNull();

		await releaseHotWalletAfterL1('wallet-1', newerToken);
		expect(wallet.lockedAt).toBeNull();
		expect(wallet.lockPurpose).toBeNull();
	});

	it('leaves the lock alone for a row written before claims carried a token', async () => {
		await claimHotWalletForL1('wallet-1', 'top-up');

		await releaseHotWalletAfterL1('wallet-1', null);

		expect(wallet.lockedAt).not.toBeNull();
	});
});
