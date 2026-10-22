/**
 * The mainnet incident of 2026-10-22, end to end against PostgreSQL: an admin
 * released an L2 withdrawal, its body then confirmed in the head, and replay
 * held on it with `replay-apply-retry`. Seeds the reservation, releases it with
 * the real release, replays the signed body, re-applies, and replays again.
 *
 * Needs a database with every migration applied (pnpm run prisma:migrate).
 * Only the Hydra node is faked: it reports the signed body as confirmed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'crypto';
import {
	BigNum,
	Credential,
	Ed25519KeyHashes,
	EnterpriseAddress,
	FixedTransaction,
	make_vkey_witness,
	PrivateKey,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutputs,
	TransactionWitnessSet,
	Vkeywitnesses,
} from '@emurgo/cardano-serialization-lib-nodejs';
import {
	HotWalletType,
	Network,
	OnChainState,
	PaymentAction,
	PaymentSourceType,
	RPCProvider,
	TransactionLayer,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import { HydraTransactionType, type HydraConfirmedTransaction } from '@/lib/hydra/hydra/types';

const databaseUrl = process.env.HYDRA_REAPPLY_DATABASE_URL;
const describePostgres = databaseUrl == null ? describe.skip : describe;
if (databaseUrl != null) process.env.DATABASE_URL = databaseUrl;

let confirmedBodies = new Map<string, HydraConfirmedTransaction>();
const node = { getConfirmedTransaction: (txHash: string) => confirmedBodies.get(txHash) ?? null };
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: () => node }),
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { prisma } = await import('@masumi/payment-core/db');
const { generateBlockchainIdentifier } = await import('@masumi/payment-core/blockchain-identifier');
const { applyConfirmedHydraTransaction } = await import('@/services/hydra-connection-manager/head-tx-confirmed');
const { releaseRejectedL2Reservation } = await import('./l2-reservation-release');
const { findStalledReleasedL2Reservation, reapplyReleasedL2Reservation } =
	await import('./operator-l2-reservation-reapply');
const { REPLAY_APPLY_RETRY_REASON } = await import('./replay-stall-reason');

const host = {
	getProvider: () => null,
	getNode: () => node as never,
	flushHeadStatus: async () => {},
	isStatusQuarantined: () => false,
};

const run = randomUUID().replaceAll('-', '').slice(0, 12);
const ESCROW_TX_HASH = 'ab'.repeat(32);
/** Far past the preprod zero slot, so the signed upper bound converts to head time. */
const TTL_SLOT = 200_000_000;

function key(fill: number) {
	const privateKey = PrivateKey.from_normal_bytes(new Uint8Array(32).fill(fill));
	const hash = privateKey.to_public().hash();
	return {
		privateKey,
		vkey: hash.to_hex(),
		address: EnterpriseAddress.new(0, Credential.from_keyhash(hash)).to_address().to_bech32(),
	};
}
const seller = key(11);
const buyer = key(12);

/** A withdrawal of the escrow output, signed by the seller, as the head confirmed it. */
function signedWithdrawal(): HydraConfirmedTransaction {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(ESCROW_TX_HASH), 0));
	const body = TransactionBody.new(inputs, TransactionOutputs.new(), BigNum.from_str('0'));
	body.set_ttl(BigNum.from_str(String(TTL_SLOT)));
	const required = Ed25519KeyHashes.new();
	required.add(seller.privateKey.to_public().hash());
	body.set_required_signers(required);
	const txHash = FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash();
	const vkeys = Vkeywitnesses.new();
	vkeys.add(make_vkey_witness(txHash, seller.privateKey));
	const witnesses = TransactionWitnessSet.new();
	witnesses.set_vkeys(vkeys);
	return {
		type: HydraTransactionType.TxConwayEra,
		description: '',
		txId: txHash.to_hex(),
		cborHex: Transaction.new(body, witnesses).to_hex(),
		confirmedAtMs: Date.now(),
		snapshotSequence: 1,
		snapshotTransactionIndex: 0,
	};
}

const ids = {
	config: `cfg-${run}`,
	source: `src-${run}`,
	secret: `sec-${run}`,
	hotWallet: `hw-${run}`,
	remote: `rw-${run}`,
	relation: `rel-${run}`,
	head: `head-${run}`,
	apiKey: `key-${run}`,
};
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${run}-${sequence++}`;

async function seedHead() {
	await prisma.paymentSourceConfig.create({
		data: { id: ids.config, rpcProviderApiKey: 'unused', rpcProvider: RPCProvider.Blockfrost },
	});
	await prisma.paymentSource.create({
		data: {
			id: ids.source,
			network: Network.Preprod,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			requiredAdminSignatures: 1,
			smartContractAddress: `addr_test1_escrow_${run}`,
			feeRatePermille: 50,
			cooldownTime: 0,
			paymentSourceConfigId: ids.config,
			disableSyncAt: new Date(),
			// A deferred trigger requires the admin wallets in the same transaction.
			AdminWallets: { create: { walletAddress: seller.address, order: 0 } },
		},
	});
	await prisma.walletSecret.create({ data: { id: ids.secret, encryptedMnemonic: 'unused' } });
	await prisma.hotWallet.create({
		data: {
			id: ids.hotWallet,
			walletVkey: seller.vkey,
			walletAddress: seller.address,
			type: HotWalletType.Selling,
			secretId: ids.secret,
			paymentSourceId: ids.source,
		},
	});
	await prisma.walletBase.create({
		data: {
			id: ids.remote,
			walletVkey: buyer.vkey,
			walletAddress: buyer.address,
			type: WalletType.Buyer,
			paymentSourceId: ids.source,
		},
	});
	await prisma.hydraRelation.create({
		data: { id: ids.relation, network: Network.Preprod, localHotWalletId: ids.hotWallet, remoteWalletId: ids.remote },
	});
	await prisma.hydraHead.create({ data: { id: ids.head, hydraRelationId: ids.relation, initTxHash: 'init' } });
	await prisma.apiKey.create({
		data: {
			id: ids.apiKey,
			token: `token-${run}`,
			tokenHash: `hash-${run}`,
			status: 'Active',
			canRead: true,
			canPay: true,
			canAdmin: true,
			networkLimit: [],
		},
	});
}

/**
 * A payment whose WithdrawInitiated reservation the admin released: the state
 * the incident left, reached through the real release.
 */
async function seedReleasedWithdrawal(body: HydraConfirmedTransaction) {
	const escrow = await prisma.transaction.create({
		data: {
			id: nextId('escrow'),
			txHash: ESCROW_TX_HASH,
			status: TransactionStatus.Confirmed,
			layer: TransactionLayer.L2,
			hydraHeadId: ids.head,
			previousOnChainState: OnChainState.ResultSubmitted,
			newOnChainState: OnChainState.WithdrawAuthorized,
		},
	});
	const reservation = await prisma.transaction.create({
		data: {
			id: nextId('reservation'),
			intendedTxHash: body.txId,
			status: TransactionStatus.Pending,
			layer: TransactionLayer.L2,
			hydraHeadId: ids.head,
			l2ReservationPreviousTransactionId: escrow.id,
		},
	});
	await prisma.hotWallet.update({
		where: { id: ids.hotWallet },
		data: { lockedAt: new Date(), pendingTransactionId: reservation.id },
	});
	const action = await prisma.paymentActionData.create({
		data: { id: nextId('action'), requestedAction: PaymentAction.WithdrawInitiated },
	});
	const payment = await prisma.paymentRequest.create({
		data: {
			id: nextId('payment'),
			paymentSourceId: ids.source,
			nextActionId: action.id,
			// Unique per case: the identifier is a unique key.
			blockchainIdentifier: generateBlockchainIdentifier(
				'01'.repeat(32),
				randomUUID().replaceAll('-', ''),
				'03'.repeat(32),
				'04'.repeat(16),
			),
			submitResultTime: 0n,
			unlockTime: 0n,
			externalDisputeUnlockTime: 0n,
			inputHash: 'input',
			sellerCoolDownTime: 0n,
			buyerCoolDownTime: 0n,
			requestedById: ids.apiKey,
			layer: TransactionLayer.L2,
			onChainState: OnChainState.WithdrawAuthorized,
			resultHash: 'cd'.repeat(32),
			collateralReturnLovelace: 0n,
			currentHydraUtxoTxHash: ESCROW_TX_HASH,
			currentHydraUtxoOutputIndex: 0,
			currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '5000000' }],
			buyerWalletId: ids.remote,
			smartContractWalletId: ids.hotWallet,
			currentTransactionId: reservation.id,
		},
	});
	await prisma.paymentRequest.update({
		where: { id: payment.id },
		data: { TransactionHistory: { connect: { id: escrow.id } } },
	});
	const released = await releaseRejectedL2Reservation(
		{
			id: reservation.id,
			l2ReservationPreviousLayer: null,
			l2ReservationPreviousSmartContractWalletId: null,
			l2ReservationPreviousBuyerReturnAddress: null,
			l2ReservationPreviousCollateralReturn: null,
			l2ReservationPreviousTransactionId: escrow.id,
		},
		prisma,
		'operator',
	);
	expect(released).toBe(true);
	return { escrow, reservation, payment };
}

/** Each case starts from a head with no requests or transactions; every body hashes the same. */
async function clearRows() {
	await prisma.hotWallet.updateMany({
		where: { id: ids.hotWallet },
		data: { pendingTransactionId: null, lockedAt: null },
	});
	await prisma.paymentRequest.deleteMany({ where: { paymentSourceId: ids.source } });
	await prisma.paymentActionData.deleteMany({ where: { id: { contains: run } } });
	await prisma.transaction.deleteMany({ where: { hydraHeadId: ids.head } });
}

async function stallHeadOn(txHash: string) {
	await prisma.hydraHead.update({
		where: { id: ids.head },
		data: {
			reconciliationStalledTxId: txHash,
			reconciliationStalledReason: REPLAY_APPLY_RETRY_REASON,
			reconciliationStalledSince: new Date(),
		},
	});
}

async function reapply(transactionId: string) {
	const { reservation } = await findStalledReleasedL2Reservation(ids.head);
	return await reapplyReleasedL2Reservation({
		headId: ids.head,
		transactionId,
		expectedUpdatedAt: reservation?.updatedAt ?? new Date(0),
		actorApiKeyId: ids.apiKey,
	});
}

describePostgres('re-applying a released L2 reservation whose body confirmed (PostgreSQL)', () => {
	beforeAll(async () => {
		await seedHead();
	});

	beforeEach(async () => {
		await clearRows();
	});

	afterAll(async () => {
		await clearRows();
		await prisma.hydraHead.delete({ where: { id: ids.head } });
		await prisma.hydraRelation.delete({ where: { id: ids.relation } });
		await prisma.walletBase.delete({ where: { id: ids.remote } });
		await prisma.hotWallet.delete({ where: { id: ids.hotWallet } });
		await prisma.walletSecret.delete({ where: { id: ids.secret } });
		await prisma.apiKey.delete({ where: { id: ids.apiKey } });
		await prisma.$transaction([
			prisma.adminWallet.deleteMany({ where: { paymentSourceAdminId: ids.source } }),
			prisma.paymentSource.delete({ where: { id: ids.source } }),
		]);
		await prisma.paymentSourceConfig.delete({ where: { id: ids.config } });
		await prisma.$disconnect();
	});

	it('holds replay on the released body, and applies it after the re-apply', async () => {
		const body = signedWithdrawal();
		confirmedBodies = new Map([[body.txId, body]]);
		const { escrow, reservation, payment } = await seedReleasedWithdrawal(body);

		// The incident: the released body confirms and replay holds on it.
		await expect(applyConfirmedHydraTransaction(host, ids.head, body.txId, body)).resolves.toBe('retry');
		await stallHeadOn(body.txId);
		const shown = await findStalledReleasedL2Reservation(ids.head);
		expect(shown.reservation).toMatchObject({
			transactionId: reservation.id,
			releasedBy: 'operator',
			kind: 'action',
			paymentRequestIds: [payment.id],
			reapplicable: true,
		});

		await reapply(reservation.id);
		const restored = await prisma.paymentRequest.findUniqueOrThrow({
			where: { id: payment.id },
			include: { NextAction: true },
		});
		expect(restored.currentTransactionId).toBe(reservation.id);
		expect(restored.NextAction.requestedAction).toBe(PaymentAction.WithdrawInitiated);

		// The next replay pass applies the body the normal way.
		await expect(applyConfirmedHydraTransaction(host, ids.head, body.txId, body)).resolves.toBe('applied');
		const confirmed = await prisma.transaction.findUniqueOrThrow({ where: { id: reservation.id } });
		expect(confirmed).toMatchObject({
			status: TransactionStatus.Confirmed,
			txHash: body.txId,
			l2ReleasedByOperatorAt: null,
			previousOnChainState: OnChainState.WithdrawAuthorized,
			newOnChainState: OnChainState.Withdrawn,
		});
		const settled = await prisma.paymentRequest.findUniqueOrThrow({
			where: { id: payment.id },
			include: { TransactionHistory: { select: { id: true } } },
		});
		expect(settled.onChainState).toBe(OnChainState.Withdrawn);
		expect(settled.currentTransactionId).toBe(reservation.id);
		expect(settled.TransactionHistory.map((row) => row.id)).toContain(escrow.id);
	});

	it('refuses while a retry of the released action is in flight', async () => {
		const body = signedWithdrawal();
		confirmedBodies = new Map([[body.txId, body]]);
		const { reservation, payment } = await seedReleasedWithdrawal(body);
		const retry = await prisma.transaction.create({
			data: {
				id: nextId('retry'),
				status: TransactionStatus.Pending,
				layer: TransactionLayer.L2,
				hydraHeadId: ids.head,
			},
		});
		await prisma.paymentRequest.update({
			where: { id: payment.id },
			data: { CurrentTransaction: { connect: { id: retry.id } } },
		});
		await stallHeadOn(body.txId);

		const shown = await findStalledReleasedL2Reservation(ids.head);
		expect(shown.reservation?.blockedReason).toContain('has moved on since the release');
		await expect(reapply(reservation.id)).rejects.toMatchObject({ status: 409 });
		const untouched = await prisma.transaction.findUniqueOrThrow({ where: { id: reservation.id } });
		expect(untouched.status).toBe(TransactionStatus.RolledBack);
	});

	it('refuses when the request was worked on after the release', async () => {
		const body = signedWithdrawal();
		confirmedBodies = new Map([[body.txId, body]]);
		const { reservation, payment } = await seedReleasedWithdrawal(body);
		// An error, then an operator's error-state recovery back to the retry action.
		for (const requestedAction of [PaymentAction.WaitingForManualAction, PaymentAction.WithdrawRequested]) {
			const current = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: payment.id } });
			await prisma.paymentRequest.update({
				where: { id: payment.id },
				data: {
					ActionHistory: { connect: { id: current.nextActionId } },
					NextAction: { create: { id: nextId('action'), requestedAction } },
				},
			});
		}
		await stallHeadOn(body.txId);

		const shown = await findStalledReleasedL2Reservation(ids.head);
		expect(shown.reservation?.blockedReason).toContain('no longer in the retry action its release left it in');
		await expect(reapply(reservation.id)).rejects.toMatchObject({ status: 409 });
	});

	it('refuses a released initial lock, whose purchase may be locked again', async () => {
		const body = signedWithdrawal();
		confirmedBodies = new Map([[body.txId, body]]);
		const initialLock = await prisma.transaction.create({
			data: {
				id: nextId('initial-lock'),
				intendedTxHash: body.txId,
				status: TransactionStatus.RolledBack,
				layer: TransactionLayer.L2,
				hydraHeadId: ids.head,
				l2ReleasedByOperatorAt: new Date(),
			},
		});
		await stallHeadOn(body.txId);

		const shown = await findStalledReleasedL2Reservation(ids.head);
		expect(shown.reservation).toMatchObject({
			kind: 'initial-lock',
			reapplicable: false,
			blockedReason: expect.stringContaining('An initial lock'),
		});
		await expect(reapply(initialLock.id)).rejects.toMatchObject({ status: 409 });
		const untouched = await prisma.transaction.findUniqueOrThrow({ where: { id: initialLock.id } });
		expect(untouched).toMatchObject({ status: TransactionStatus.RolledBack });
		expect(untouched.l2ReleasedByOperatorAt).not.toBeNull();
	});

	it('refuses an action released on the input proof, which says the body can never confirm', async () => {
		const body = signedWithdrawal();
		confirmedBodies = new Map([[body.txId, body]]);
		const { reservation } = await seedReleasedWithdrawal(body);
		await prisma.transaction.update({
			where: { id: reservation.id },
			data: { l2ReleasedByOperatorAt: null, l2ReleasedByInputProofAt: new Date() },
		});
		await stallHeadOn(body.txId);

		const shown = await findStalledReleasedL2Reservation(ids.head);
		expect(shown.reservation).toMatchObject({
			releasedBy: 'input-proof',
			reapplicable: false,
			blockedReason: expect.stringContaining('input proof'),
		});
		await expect(reapply(reservation.id)).rejects.toMatchObject({ status: 409 });
	});
});
