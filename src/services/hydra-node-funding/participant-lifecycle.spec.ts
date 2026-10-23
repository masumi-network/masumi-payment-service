import { beforeEach, expect, it, jest } from '@jest/globals';
import { HydraInviteStatus, Network, Prisma, TransactionStatus } from '@/generated/prisma/client';

const address = 'node-address';
const participant = {
	id: 'participant',
	hydraHostId: 'host',
	hostNodeId: 'node',
	hydraHeadId: null,
	hydraSecretKeyId: 'key',
	cardanoVkey: 'vkey',
	walletId: 'wallet',
	autoFund: true,
	automaticFundingLimitLovelace: null,
	HydraHead: null,
	Wallet: { PaymentSource: { network: Network.Preprod, PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
};
type Transfer = {
	id: string;
	toAddress: string;
	status: TransactionStatus;
	createdAt: Date;
	lastCheckedAt: Date | null;
};
let exists: boolean;
let liveInvite: boolean;
let transfers: Transfer[];
let keyDeleted: boolean;
let duringHostRemoval: () => Promise<void>;
let duringBalanceRead: () => Promise<void>;
let duringSweep: () => Promise<void>;
let insideTransaction: boolean;
let beforeTransaction: () => Promise<void>;
const transactionOptions: object[] = [];

function matches(transfer: Transfer, where: Prisma.WalletFundTransferWhereInput): boolean {
	if (where.toAddress && where.toAddress !== transfer.toAddress) return false;
	if (where.status && where.status !== transfer.status) return false;
	if (where.id && typeof where.id === 'object' && Array.isArray(where.id.notIn) && where.id.notIn.includes(transfer.id))
		return false;
	if (where.lastCheckedAt === null && transfer.lastCheckedAt !== null) return false;
	for (const field of ['lastCheckedAt', 'createdAt'] as const) {
		const filter = where[field];
		if (filter && typeof filter === 'object' && 'gte' in filter && filter.gte instanceof Date) {
			if (transfer[field] === null || transfer[field]! < filter.gte) return false;
		}
	}
	return !where.OR || where.OR.some((clause) => matches(transfer, clause));
}
const db = {
	hydraLocalParticipant: {
		findMany: async () => (exists ? [participant] : []),
		findUnique: async () => (exists ? participant : null),
		findUniqueOrThrow: async () => participant, // A snapshot already read before cleanup.
		deleteMany: async () => {
			exists = false;
			return { count: 1 };
		},
	},
	hydraHeadInvite: {
		findMany: async () => (liveInvite ? [{ ...participant, status: HydraInviteStatus.Issued }] : []),
		findFirst: async () => (liveInvite ? { id: 'invite' } : null),
	},
	hydraSecretKey: {
		deleteMany: async () => {
			keyDeleted = true;
			return { count: 1 };
		},
	},
	hydraHost: { findUnique: async () => ({ baseUrl: 'https://host.example', encryptedAdminToken: 'token' }) },
	walletFundTransfer: {
		findMany: async ({ where }: { where: Prisma.WalletFundTransferWhereInput }) =>
			transfers.filter((row) => matches(row, where)),
		findFirst: async ({ where }: { where: Prisma.WalletFundTransferWhereInput }) =>
			transfers.find((row) => matches(row, where)) ?? null,
		create: async () => {
			const row = {
				id: 'transfer',
				toAddress: address,
				status: TransactionStatus.Pending,
				createdAt: new Date(),
				lastCheckedAt: null,
			};
			transfers.push(row);
			return row;
		},
	},
};
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		...db,
		$transaction: async (run: (tx: typeof db) => Promise<unknown>, options: object) => {
			transactionOptions.push(options);
			await beforeTransaction();
			insideTransaction = true;
			try {
				return await run(db);
			} finally {
				insideTransaction = false;
			}
		},
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('./node-address', () => ({ nodeCardanoAddress: () => address }));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({
		addressesExtended: async () => {
			expect(insideTransaction).toBe(false);
			await duringBalanceRead();
			return { amount: [] };
		},
	}),
}));
jest.unstable_mockModule('@/services/hydra-node-funding/withdraw', () => ({
	withdrawNodeFunds: async () => {
		expect(insideTransaction).toBe(false);
		await duringSweep();
		return { address, balanceLovelace: '0', code: 'dust' };
	},
}));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	removeHostNode: async () => {
		expect(insideTransaction).toBe(false);
		await duringHostRemoval();
	},
	HydraHostRequestError: class extends Error {},
}));
const { fundHydraNodeNow, runHydraNodeFundingCycle } = await import('./service');
const { releaseReservedParticipants } = await import('@/services/hydra-invite/release-reservation');
const release = () => releaseReservedParticipants({ hydraHostId: 'host', hostNodeId: 'node' });

beforeEach(() => {
	exists = true;
	liveInvite = false;
	transfers = [];
	keyDeleted = false;
	insideTransaction = false;
	transactionOptions.length = 0;
	duringHostRemoval = async () => {};
	duringBalanceRead = async () => {};
	duringSweep = async () => {};
	beforeTransaction = async () => {};
});

it.each([TransactionStatus.Pending, TransactionStatus.Confirmed])(
	'keeps the signer when manual funding becomes %s during Host removal',
	async (status) => {
		duringHostRemoval = async () => {
			await fundHydraNodeNow(participant.id);
			transfers[0].status = status;
			transfers[0].lastCheckedAt = new Date();
		};
		await expect(release()).resolves.toEqual({ released: 0, retained: 1 });
		expect(exists).toBe(true);
		expect(keyDeleted).toBe(false);
		expect(
			transactionOptions.every((options) => (options as { isolationLevel: string }).isolationLevel === 'Serializable'),
		).toBe(true);
	},
);

it('does not age a transfer out while chain and Host work run', async () => {
	duringSweep = async () => {
		await fundHydraNodeNow(participant.id);
		transfers[0].status = TransactionStatus.Confirmed;
		transfers[0].createdAt = new Date(0);
		transfers[0].lastCheckedAt = new Date(0);
	};
	await expect(release()).resolves.toEqual({ released: 0, retained: 1 });
	expect(keyDeleted).toBe(false);
});

it('rejects a manual claim whose participant was deleted during the balance read', async () => {
	duringBalanceRead = async () => {
		await expect(release()).resolves.toEqual({ released: 1, retained: 0 });
	};
	await expect(fundHydraNodeNow(participant.id)).rejects.toMatchObject({ status: 404 });
	expect(transfers).toHaveLength(0);
	expect(keyDeleted).toBe(true);
});

it('rechecks the live invite before automatic funding from a stale scheduler snapshot', async () => {
	liveInvite = true;
	duringBalanceRead = async () => {
		liveInvite = false;
	};
	await expect(runHydraNodeFundingCycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
	expect(transfers).toHaveLength(0);
});

it('releases an empty reservation when funding has not changed', async () => {
	await expect(release()).resolves.toEqual({ released: 1, retained: 0 });
	expect(keyDeleted).toBe(true);
});

it('allows cleanup after historical funding was observed before settlement', async () => {
	transfers.push({
		id: 'historical-transfer',
		toAddress: address,
		status: TransactionStatus.Confirmed,
		createdAt: new Date(0),
		lastCheckedAt: new Date(0),
	});
	await expect(release()).resolves.toEqual({ released: 1, retained: 0 });
	expect(keyDeleted).toBe(true);
});

it('keeps recently confirmed funding even if the indexer reports dust', async () => {
	transfers.push({
		id: 'recent-transfer',
		toAddress: address,
		status: TransactionStatus.Confirmed,
		createdAt: new Date(0),
		lastCheckedAt: new Date(),
	});
	await expect(release()).resolves.toEqual({ released: 0, retained: 1 });
	expect(keyDeleted).toBe(false);
});

it('still funds an automatically funded reservation with a live invite', async () => {
	liveInvite = true;
	await expect(runHydraNodeFundingCycle()).resolves.toMatchObject({ funded: 1 });
	expect(transfers).toHaveLength(1);
});

it('rechecks transfer history after a cleanup serialization conflict', async () => {
	beforeTransaction = async () => {
		beforeTransaction = async () => {};
		// A peer committed funding before this transaction could commit.
		transfers.push({
			id: 'peer-transfer',
			toAddress: address,
			status: TransactionStatus.Confirmed,
			createdAt: new Date(0),
			lastCheckedAt: new Date(0),
		});
		throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
	};
	await expect(release()).resolves.toEqual({ released: 0, retained: 1 });
	expect(transactionOptions).toHaveLength(2);
	expect(keyDeleted).toBe(false);
});

it('rechecks participant existence after a funding serialization conflict', async () => {
	beforeTransaction = async () => {
		beforeTransaction = async () => {};
		exists = false;
		throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
	};
	await expect(fundHydraNodeNow(participant.id)).rejects.toMatchObject({ status: 404 });
	expect(transactionOptions).toHaveLength(2);
	expect(transfers).toHaveLength(0);
});
