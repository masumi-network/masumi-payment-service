/**
 * Issuer adoption, interrupted at every database write and then retried.
 *
 * The database is an in-memory fake whose `$transaction` rolls back on a throw.
 * An interruption is modelled as a crash: the write that hits it does not land,
 * and every later write in that pass fails too, so no cleanup code gets to run.
 * The retry is the next poll, which the watermark offers the same redemption.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import createHttpError from 'http-errors';

type InviteRow = {
	id: string;
	nonce: string;
	role: string;
	status: string;
	network: string;
	hydraHostId: string;
	hostNodeId: string;
	localHotWalletId: string;
	contestationPeriodSeconds: number;
	hydraHeadId: string | null;
};
type LocalRow = {
	id: string;
	walletId: string;
	hydraHostId: string;
	hostNodeId: string;
	autoFund: boolean;
	hydraHeadId: string | null;
};
type RemoteRow = {
	id: string;
	walletId: string;
	cardanoVkey: string;
	advertise: string;
	hydraVerificationKeyId: string;
	hydraVK: string;
	hydraHeadId: string | null;
};
type HeadRow = { id: string; hydraRelationId: string; status: string; contestationPeriod: bigint };
type RelationRow = { id: string; network: string; localHotWalletId: string; remoteWalletId: string };
type WalletRow = { id: string; walletAddress: string };
type State = {
	invite: InviteRow;
	/** Heads some other invite already points at. */
	otherInviteHeadIds: string[];
	locals: LocalRow[];
	remotes: RemoteRow[];
	heads: HeadRow[];
	relations: RelationRow[];
	wallets: WalletRow[];
};

type OrphanWhere = {
	Invite?: { is: null };
	contestationPeriod: bigint;
	LocalParticipant: { is: { walletId: string; hydraHostId: string; hostNodeId: string } };
	HydraRelation: { network: string; localHotWalletId: string; RemoteWallet: { walletAddress: string } };
	RemoteParticipants: {
		some: { cardanoVkey: string; advertise: string; HydraVerificationKey: { hydraVK: string } };
	};
};

const host = { id: 'host', baseUrl: 'https://host.example', encryptedAdminToken: 'token', allowInsecureHttp: false };
const redeemer = {
	walletAddress: 'addr_redeemer',
	hydraVerificationKey: 'redeemer-hydra-vk',
	cardanoVerificationKey: 'redeemer-cardano-vk',
	advertise: 'redeemer.example:5001',
	exchangeUrl: 'https://redeemer.example',
};
const record = {
	nonce: 'nonce',
	redeemedAt: Date.now(),
	redeemer,
	redeemerSignature: { signature: 'signature', key: 'signer-key' },
};

let state: State;
let nextId = 0;
let writes = 0;
let crashAt: number | null = null;
let crashed = false;

function freshState(): State {
	return {
		invite: {
			id: 'invite',
			nonce: 'nonce',
			role: 'Issuer',
			status: 'Issued',
			network: 'Preprod',
			hydraHostId: 'host',
			hostNodeId: 'node',
			localHotWalletId: 'local-wallet',
			contestationPeriodSeconds: 86_400,
			hydraHeadId: null,
		},
		locals: [
			{
				id: 'local-participant',
				walletId: 'local-wallet',
				hydraHostId: 'host',
				hostNodeId: 'node',
				autoFund: true,
				hydraHeadId: null,
			},
		],
		otherInviteHeadIds: [],
		remotes: [],
		heads: [],
		relations: [],
		wallets: [],
	};
}

/** Every write passes through here; the one numbered `crashAt` is where the process dies. */
function write(label: string): void {
	if (crashed || writes === crashAt) {
		crashed = true;
		throw new Error(`process died before ${label}`);
	}
	writes += 1;
}

function id(prefix: string): string {
	nextId += 1;
	return `${prefix}-${nextId}`;
}

const tables = {
	hydraHost: { findMany: async () => [host] },
	hydraHeadInvite: {
		findUnique: async ({ where }: { where: { nonce: string } }) =>
			state.invite.nonce === where.nonce
				? { ...state.invite, LocalHotWallet: { paymentSourceId: 'payment-source' }, HydraHost: host }
				: null,
		updateMany: async ({
			where,
			data,
		}: {
			where: { id: string; status?: string; hydraHeadId?: null };
			data: { status: string; hydraHeadId?: string };
		}) => {
			write('invite update');
			const invite = state.invite;
			const matches =
				invite.id === where.id &&
				(where.status === undefined || invite.status === where.status) &&
				(!('hydraHeadId' in where) || invite.hydraHeadId === null);
			if (!matches) return { count: 0 };
			invite.status = data.status;
			if (data.hydraHeadId !== undefined) invite.hydraHeadId = data.hydraHeadId;
			return { count: 1 };
		},
	},
	hydraLocalParticipant: {
		findFirst: async ({ where }: { where: { hydraHostId: string; hostNodeId: string; hydraHeadId: null } }) => {
			const found = state.locals.find(
				(row) =>
					row.hydraHostId === where.hydraHostId && row.hostNodeId === where.hostNodeId && row.hydraHeadId === null,
			);
			return found ? { id: found.id, autoFund: found.autoFund } : null;
		},
		count: async ({ where }: { where: { hydraHostId: string; hostNodeId: string; hydraHeadId?: { not: null } } }) =>
			state.locals.filter(
				(row) =>
					row.hydraHostId === where.hydraHostId &&
					row.hostNodeId === where.hostNodeId &&
					(where.hydraHeadId === undefined || row.hydraHeadId !== null),
			).length,
	},
	walletBase: {
		upsert: async ({ create }: { create: { walletAddress: string } }) => {
			write('wallet upsert');
			const existing = state.wallets.find((row) => row.walletAddress === create.walletAddress);
			if (existing) return existing;
			const row = { id: id('wallet'), walletAddress: create.walletAddress };
			state.wallets.push(row);
			return row;
		},
	},
	hydraRelation: {
		upsert: async ({ create }: { create: { network: string; localHotWalletId: string; remoteWalletId: string } }) => {
			write('relation upsert');
			const existing = state.relations.find(
				(row) => row.localHotWalletId === create.localHotWalletId && row.remoteWalletId === create.remoteWalletId,
			);
			if (existing) return existing;
			const row = { id: id('relation'), ...create };
			state.relations.push(row);
			return row;
		},
	},
	hydraRemoteParticipant: {
		create: async ({
			data,
		}: {
			data: {
				Wallet: { connect: { id: string } };
				cardanoVkey: string;
				advertise: string;
				HydraVerificationKey: { create: { hydraVK: string } };
			};
		}) => {
			write('remote participant create');
			const row: RemoteRow = {
				id: id('remote'),
				walletId: data.Wallet.connect.id,
				cardanoVkey: data.cardanoVkey,
				advertise: data.advertise,
				hydraVerificationKeyId: id('vk'),
				hydraVK: data.HydraVerificationKey.create.hydraVK,
				hydraHeadId: null,
			};
			state.remotes.push(row);
			return row;
		},
		delete: async ({ where }: { where: { id: string } }) => {
			write('remote participant delete');
			state.remotes = state.remotes.filter((row) => row.id !== where.id);
		},
	},
	hydraVerificationKey: {
		delete: async () => {
			write('verification key delete');
		},
	},
	hydraHead: {
		// The orphan lookup, interpreted field by field.
		findFirst: async ({ where }: { where: OrphanWhere }) => {
			const head = state.heads.find((row) => {
				const linked = state.invite.hydraHeadId === row.id || state.otherInviteHeadIds.includes(row.id);
				// Applied only when the query asks for it, so dropping the filter fails the spec.
				if ((where.Invite?.is === null && linked) || row.contestationPeriod !== where.contestationPeriod) return false;
				const local = state.locals.find((participant) => participant.hydraHeadId === row.id);
				const wantedLocal = where.LocalParticipant.is;
				if (
					!local ||
					local.walletId !== wantedLocal.walletId ||
					local.hydraHostId !== wantedLocal.hydraHostId ||
					local.hostNodeId !== wantedLocal.hostNodeId
				)
					return false;
				const relation = state.relations.find((candidate) => candidate.id === row.hydraRelationId);
				const remoteWallet = state.wallets.find((wallet) => wallet.id === relation?.remoteWalletId);
				if (
					!relation ||
					relation.network !== where.HydraRelation.network ||
					relation.localHotWalletId !== where.HydraRelation.localHotWalletId ||
					remoteWallet?.walletAddress !== where.HydraRelation.RemoteWallet.walletAddress
				)
					return false;
				const wantedRemote = where.RemoteParticipants.some;
				return state.remotes.some(
					(remote) =>
						remote.hydraHeadId === row.id &&
						remote.cardanoVkey === wantedRemote.cardanoVkey &&
						remote.advertise === wantedRemote.advertise &&
						remote.hydraVK === wantedRemote.HydraVerificationKey.hydraVK,
				);
			});
			if (!head) return null;
			const local = state.locals.find((participant) => participant.hydraHeadId === head.id);
			return {
				id: head.id,
				status: head.status,
				LocalParticipant: local ? { id: local.id, autoFund: local.autoFund } : null,
			};
		},
	},
};

const db = {
	...tables,
	$transaction: async <T>(operation: (tx: typeof tables) => Promise<T>): Promise<T> => {
		const snapshot = structuredClone(state);
		try {
			return await operation(db);
		} catch (error) {
			state = snapshot;
			throw error;
		}
	},
};

/** createBoundHydraHead's writes, in its order, in one rolled-back-on-throw transaction. */
async function fakeCreateBoundHydraHead(input: {
	hydraRelationId: string;
	contestationPeriod: bigint;
	localParticipantId: string;
	remoteParticipantId: string;
	linkInvite?: (tx: typeof tables, hydraHeadId: string) => Promise<void>;
}): Promise<{ id: string }> {
	return await db.$transaction(async (tx) => {
		if (state.heads.some((row) => row.hydraRelationId === input.hydraRelationId && row.status !== 'Final')) {
			throw createHttpError(409, 'Hydra relation already has a non-final head');
		}
		const local = state.locals.find((row) => row.id === input.localParticipantId);
		const remote = state.remotes.find((row) => row.id === input.remoteParticipantId);
		if (!local || local.hydraHeadId !== null) throw createHttpError(409, 'Local participant is already assigned');
		if (!remote || remote.hydraHeadId !== null) throw createHttpError(409, 'Remote participant is already assigned');

		write('head create');
		const head: HeadRow = {
			id: id('head'),
			hydraRelationId: input.hydraRelationId,
			status: 'Idle',
			contestationPeriod: input.contestationPeriod,
		};
		state.heads.push(head);
		write('local participant claim');
		local.hydraHeadId = head.id;
		write('remote participant claim');
		remote.hydraHeadId = head.id;
		await input.linkInvite?.(tx, head.id);
		return { id: head.id };
	});
}

const forget = jest.fn(async () => {});
const remove = jest.fn(async () => {});
const fund = jest.fn(async (_localParticipantId: string, _automatic: boolean) => {});

jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: db }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	fetchHostRedemptions: async () => ({ now: Date.now(), invites: [record] }),
	forgetHostInvite: forget,
	removeHostNode: remove,
	registerInviteOnHost: jest.fn(),
	setHostNodePeers: jest.fn(),
	startHostNode: jest.fn(),
	HydraHostRequestError: class extends Error {},
}));
jest.unstable_mockModule('@/routes/api/hydra/head/create-head', () => ({
	createBoundHydraHead: fakeCreateBoundHydraHead,
}));
jest.unstable_mockModule('@meshsdk/core', () => ({ resolvePaymentKeyHash: (address: string) => `pkh(${address})` }));
jest.unstable_mockModule('./node-keys', () => ({ deriveNodeCardanoVkey: (key: string) => `vkh(${key})` }));
jest.unstable_mockModule('./invite-signing', () => ({
	verifyHydraRedemption: async () => {},
	verifyHydraHeadInvite: jest.fn(),
	signHydraHeadInvite: jest.fn(),
	signHydraRedemption: jest.fn(),
}));
jest.unstable_mockModule('./invite-payload', () => ({
	INVITE_TTL_MS: 0,
	buildHydraRedemptionPayload: jest.fn(),
	checkInviteFreshness: jest.fn(),
}));
jest.unstable_mockModule('./invite-code', () => ({ encodeInviteCode: jest.fn() }));
jest.unstable_mockModule('./provisioning', () => ({
	MIN_UNSYNCED_PERIOD_SECONDS: 0,
	assertContestationPeriodAllowed: jest.fn(),
	assertHeadPeriodsAllowed: jest.fn(),
	defaultPeriodsFor: jest.fn(),
	periodsFromInvite: jest.fn(),
	reserveNodeForExchange: jest.fn(),
}));
jest.unstable_mockModule('./exchange-client', () => ({
	assertExchangeTransportAllowed: jest.fn(),
	postRedemption: jest.fn(),
	resolveExchangeTarget: jest.fn(),
}));
jest.unstable_mockModule('@/services/hydra-host/compatibility', () => ({
	expectedHostCapabilitiesForNetwork: jest.fn(),
}));
jest.unstable_mockModule('./release-reservation', () => ({
	releaseReservedParticipants: async () => {},
	canRemoveReservedHostNode: async () => true,
}));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({ fundHydraNodeNow: fund }));

const { pollHydraRedemptions } = await import('./adoption');

/** Rows a correct adoption leaves: one head, its participants bound, its invite linked. */
function expectAdoptedOnce(): void {
	expect(state.heads).toHaveLength(1);
	const [head] = state.heads;
	expect(state.invite).toMatchObject({ status: 'Completed', hydraHeadId: head.id });
	expect(state.locals[0].hydraHeadId).toBe(head.id);
	expect(state.remotes.filter((row) => row.hydraHeadId === head.id)).toHaveLength(1);
	expect(remove).not.toHaveBeenCalled();
}

/** A head whose participants match the redemption but which no invite points at. */
function seedOrphanedHead(remoteOverrides: Partial<RemoteRow> = {}): void {
	state.wallets.push({ id: 'remote-wallet', walletAddress: redeemer.walletAddress });
	state.relations.push({
		id: 'relation',
		network: 'Preprod',
		localHotWalletId: 'local-wallet',
		remoteWalletId: 'remote-wallet',
	});
	state.heads.push({ id: 'orphan', hydraRelationId: 'relation', status: 'Idle', contestationPeriod: 86_400n });
	state.locals[0].hydraHeadId = 'orphan';
	state.remotes.push({
		id: 'remote',
		walletId: 'remote-wallet',
		cardanoVkey: `vkh(${redeemer.cardanoVerificationKey})`,
		advertise: redeemer.advertise,
		hydraVerificationKeyId: 'vk',
		hydraVK: redeemer.hydraVerificationKey,
		hydraHeadId: 'orphan',
		...remoteOverrides,
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	state = freshState();
	writes = 0;
	crashAt = null;
	crashed = false;
});

describe('issuer adoption interrupted at each write', () => {
	it('adopts on retry from every interruption point, with one head and no revoked invite', async () => {
		expect(await pollHydraRedemptions()).toMatchObject({ adopted: 1, rejected: 0 });
		const totalWrites = writes;
		// Wallet, relation, remote participant, head, two claims, invite link.
		expect(totalWrites).toBe(7);

		for (let interruptAt = 0; interruptAt < totalWrites; interruptAt += 1) {
			jest.clearAllMocks();
			state = freshState();
			writes = 0;
			crashed = false;
			crashAt = interruptAt;

			expect(await pollHydraRedemptions()).toMatchObject({ adopted: 0, rejected: 1 });
			expect(crashed).toBe(true);
			// Nothing the crash left behind may point the invite at a head yet.
			expect(state.invite).toMatchObject({ status: 'Issued', hydraHeadId: null });
			expect(state.locals[0].hydraHeadId).toBeNull();
			expect(state.heads).toHaveLength(0);

			crashAt = null;
			crashed = false;
			expect(await pollHydraRedemptions()).toMatchObject({ adopted: 1, rejected: 0 });
			expectAdoptedOnce();
			expect(forget).toHaveBeenCalledTimes(1);
		}
	});

	it('re-links a verified head an earlier pass orphaned instead of revoking its invite', async () => {
		seedOrphanedHead();

		expect(await pollHydraRedemptions()).toMatchObject({ adopted: 1, rejected: 0 });
		expectAdoptedOnce();
		expect(state.heads[0].id).toBe('orphan');
		expect(fund).toHaveBeenCalledWith('local-participant', true);
	});

	it('re-links an orphaned head even when the repair itself was interrupted once', async () => {
		seedOrphanedHead();
		crashAt = 0;

		expect(await pollHydraRedemptions()).toMatchObject({ adopted: 0, rejected: 1 });
		expect(state.invite).toMatchObject({ status: 'Issued', hydraHeadId: null });

		crashAt = null;
		crashed = false;
		expect(await pollHydraRedemptions()).toMatchObject({ adopted: 1, rejected: 0 });
		expectAdoptedOnce();
	});

	it('does not claim a matching head that another invite already points at', async () => {
		seedOrphanedHead();
		state.otherInviteHeadIds.push('orphan');

		expect(await pollHydraRedemptions()).toMatchObject({ adopted: 0, rejected: 1 });
		expect(state.invite.status).toBe('Revoked');
		expect(state.invite.hydraHeadId).toBeNull();
	});

	it('leaves a head that does not match the redemption alone, without an invite', async () => {
		// A legacy head on this node, or one for some other counterparty key.
		seedOrphanedHead({ hydraVK: 'some-other-hydra-vk' });

		expect(await pollHydraRedemptions()).toMatchObject({ adopted: 0, rejected: 1 });
		expect(state.invite.status).toBe('Revoked');
		expect(state.invite.hydraHeadId).toBeNull();
		expect(state.heads).toEqual([expect.objectContaining({ id: 'orphan', status: 'Idle' })]);
		// The node still serves that head, so it is not removed.
		expect(remove).not.toHaveBeenCalled();
	});
});
