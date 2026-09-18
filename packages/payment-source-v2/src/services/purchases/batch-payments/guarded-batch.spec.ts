import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { deserializeDatum, MeshWallet, resolvePaymentKeyHash, serializeData, type UTxO } from '@meshsdk/core';
import {
	blake2b,
	deserializeTx,
	Ed25519PublicKey,
	Ed25519PublicKeyHex,
	HexBlob,
	resolveTxHash,
} from '@meshsdk/core-cst';
import { HotWalletType, PurchasingAction, TransactionStatus } from '@/generated/prisma/client';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import type { WalletDatum } from '../../../smart-wallet/wallet';

const ESCROW_ADDRESS = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
const AGENT_WORDS = 'solution '.repeat(23).concat('solution').split(' ');
const SELLER_WORDS = 'abandon '.repeat(23).concat('art').split(' ');
const ADA = 1_000_000n;

type Call = { data: Record<string, unknown>; where: Record<string, unknown> };
const last = <T>(items: T[]): T | undefined => items[items.length - 1];
const purchaseUpdates: Call[] = [];
const transactionUpdates: Call[] = [];
const hotWalletUpdates: Call[] = [];
const mockPaymentSourceFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockErrorLog = jest.fn();
const mockWarnLog = jest.fn();

const prismaMock = {
	$transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock),
	paymentSource: { findMany: mockPaymentSourceFindMany },
	transaction: {
		create: jest.fn(async () => ({ id: 'placeholder-tx' })),
		update: jest.fn(async (args: Call) => {
			transactionUpdates.push(args);
			return { id: args.where.id };
		}),
	},
	hotWallet: {
		update: jest.fn(async (args: Call) => {
			hotWalletUpdates.push(args);
			return {};
		}),
		findUnique: jest.fn(async () => ({ pendingTransactionId: null })),
		count: jest.fn(async () => 1),
	},
	purchaseRequest: {
		update: jest.fn(async (args: Call) => {
			purchaseUpdates.push(args);
			return {};
		}),
		findMany: jest.fn(async () => []),
	},
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: prismaMock }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockWarnLog, error: mockErrorLog, debug: jest.fn() },
}));
jest.unstable_mockModule('./l2-lock', () => ({
	processL2PurchaseLocks: async () => ({ deferredRequestIds: [] }),
}));
jest.unstable_mockModule('../../../utils/mesh-cost-model-sync', () => ({
	syncMeshCostModelsFromChainV2: async () => undefined,
}));
jest.unstable_mockModule('@/utils/mesh-cost-model-sync', () => ({
	withMeshCostModelLock: (_key: string, operation: () => Promise<unknown>) => operation(),
	getCachedChainProtocolParameters: () => null,
}));
jest.unstable_mockModule('@/services/wallets', () => ({
	toBalanceMapFromMeshUtxos: (utxos: UTxO[]) => {
		const balance = new Map<string, bigint>();
		for (const utxo of utxos) {
			for (const asset of utxo.output.amount) {
				balance.set(asset.unit, (balance.get(asset.unit) ?? 0n) + BigInt(asset.quantity));
			}
		}
		return balance;
	},
	walletLowBalanceMonitorService: {
		evaluateCurrentHotWalletById: async () => null,
		evaluateProjectedHotWalletById: async () => undefined,
	},
}));

let provider: Record<string, unknown>;
jest.unstable_mockModule('@/services/shared/provider-factory', () => ({
	createMeshProvider: async () => provider,
	createApiClient: () => ({}),
}));

let agentWallet: MeshWallet;
let agentUtxos: UTxO[];
let agentAddress: string;
const mockSignTx = jest.fn<(tx: string, partial?: boolean) => Promise<string>>();
const mockSubmitTx = jest.fn<(tx: string) => Promise<string>>();
jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateWalletExtended: async () => ({
		wallet: {
			getUsedAddress: () => ({ toBech32: () => agentAddress }),
			getUsedAddresses: async () => [agentAddress],
			signTx: mockSignTx,
			submitTx: mockSubmitTx,
		},
		utxos: agentUtxos,
		address: agentAddress,
	}),
}));

// Jest runs modules in a VM context whose `Map` is not the one Node's
// structuredClone produces, and Mesh's builder clones the wallet datum (a Map)
// during coin selection and then asks `instanceof Map`. Clone inside the realm.
function cloneInRealm<T>(value: T): T {
	if (value instanceof Map) {
		return new Map([...value].map(([key, entry]) => [cloneInRealm(key), cloneInRealm(entry)])) as T;
	}
	if (Array.isArray(value)) return value.map((entry) => cloneInRealm(entry)) as T;
	if (value != null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneInRealm(entry)])) as T;
	}
	return value;
}
globalThis.structuredClone = cloneInRealm;

const { batchLatestPaymentEntriesV2 } = await import('./service');
const { SmartWalletAction, walletDatumData, parseWalletDatum } = await import('../../../smart-wallet/wallet');
const { deriveSmartWalletScript } = await import('../../../smart-wallet/wallet-lifecycle');
const { CONSTANTS } = await import('@masumi/payment-core/config');

type QuorumKey = { privateKey: KeyObject; vkeyHex: string; vkh: string };
function quorumKey(): QuorumKey {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const vkeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
	return { privateKey, vkeyHex, vkh: Ed25519PublicKey.fromHex(Ed25519PublicKeyHex(vkeyHex)).hash().hex() };
}
let quorum: QuorumKey[];
let outsider: QuorumKey;

function witnessSetHex(bodyHashHex: string, signers: QuorumKey[], corrupt = false): string {
	const witnesses = signers.map((signer) => {
		const signature = sign(null, Buffer.from(bodyHashHex, 'hex'), signer.privateKey);
		if (corrupt) signature[0] ^= 0xff;
		return `825820${signer.vkeyHex}5840${signature.toString('hex')}`;
	});
	return `a100${(0x80 + witnesses.length).toString(16)}${witnesses.join('')}`;
}

let script: ReturnType<typeof deriveSmartWalletScript>;
let guarded: Record<string, unknown>;
let walletUtxo: UTxO;
const tokenName = 'cd'.repeat(32);

function purchase(index: number) {
	const now = Date.now();
	return {
		id: `purchase-${index}`,
		createdAt: new Date(now - 10 * 60_000),
		nextActionId: `action-${index}`,
		blockchainIdentifier: generateBlockchainIdentifier(
			'aa'.repeat(32),
			'bb'.repeat(64),
			`${index}`.padStart(2, '0').repeat(16),
			'dd'.repeat(16),
		),
		agentIdentifier: `${'ee'.repeat(28)}${`${index}`.padStart(2, '0').repeat(4)}`,
		inputHash: 'ff'.repeat(32),
		payByTime: BigInt(now + 60 * 60_000),
		submitResultTime: BigInt(now + 2 * 60 * 60_000),
		unlockTime: BigInt(now + 3 * 60 * 60_000),
		externalDisputeUnlockTime: BigInt(now + 4 * 60 * 60_000),
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		isLimitedToHotWallets: false,
		HotWalletLimit: [],
		PaidFunds: [{ unit: '', amount: 199n * ADA }],
		SellerWallet: { walletAddress: sellerAddress, walletVkey: resolvePaymentKeyHash(sellerAddress) },
		SmartContractWallet: null,
		NextAction: { requestedAction: PurchasingAction.FundsLockingRequested, errorType: null },
		CurrentTransaction: null,
	};
}

let sellerAddress: string;

function paymentSource(purchases: ReturnType<typeof purchase>[], isGuarded = true) {
	return {
		id: 'source-1',
		network: 'Preprod',
		smartContractAddress: ESCROW_ADDRESS,
		PaymentSourceConfig: { rpcProviderApiKey: 'preprod-test-key' },
		PurchaseRequests: purchases,
		HotWallets: [
			{
				id: 'wallet-1',
				type: HotWalletType.Purchasing,
				collectionAddress: null,
				Secret: { encryptedMnemonic: 'unused' },
				GuardedWallet: isGuarded ? guarded : null,
			},
		],
	};
}

type CosignCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const cosignCalls: CosignCall[] = [];
type Answer = (call: CosignCall, bodyHash: string, requiredSigners: string[]) => { status: number; body: unknown };

function answerWith(answers: Answer[]) {
	let next = 0;
	globalThis.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
		const call: CosignCall = {
			url: String(url),
			headers: init?.headers as Record<string, string>,
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		};
		cosignCalls.push(call);
		const bodyHex = call.body.txBodyHex as string;
		const bodyHash = blake2b.hash(HexBlob(bodyHex), 32);
		const answer = answers[Math.min(next++, answers.length - 1)](call, bodyHash, [
			resolvePaymentKeyHash(agentAddress),
			...quorum.map((member) => member.vkh),
		]);
		return new Response(JSON.stringify(answer.body), { status: answer.status });
	}) as unknown as typeof fetch;
}

const allow =
	(overrides: (bodyHash: string, requiredSigners: string[]) => Record<string, unknown> = () => ({})): Answer =>
	(_call, bodyHash, requiredSigners) => ({
		status: 200,
		body: {
			decisionId: 'dec_01J9XK3M4N5P6Q7R8S9T0V1W2X',
			txBodyHash: `blake2b_256:${bodyHash}`,
			requiredSigners,
			witnessSetHex: witnessSetHex(bodyHash, quorum.slice(0, 2)),
			...overrides(bodyHash, requiredSigners),
		},
	});

const memberDenied =
	(deniedIds: string[]): Answer =>
	(call, bodyHash, requiredSigners) => {
		const intents = call.body.intents as Array<{ purchaseId: string; outputIndex: number }>;
		return {
			status: 409,
			body: {
				decisionId: 'dec_01J9XK3M4N5P6Q7R8S9T0V1DNY',
				txBodyHash: `blake2b_256:${bodyHash}`,
				requiredSigners,
				denied: 'member_denied',
				alarm: false,
				members: intents.map((intent) =>
					deniedIds.includes(intent.purchaseId)
						? {
								purchaseId: intent.purchaseId,
								outputIndex: intent.outputIndex,
								verdict: 'denied',
								denied: 'daily_outflow',
								reasonEnglish: 'This would take the day over the mandate.',
								bound: '1000',
								used: '900',
								attempted: '199',
								retryAfterSec: 3600,
								windowResetsAt: '2026-09-19T00:00:00Z',
							}
						: { purchaseId: intent.purchaseId, outputIndex: intent.outputIndex, verdict: 'allowed' },
				),
				rebuild: {
					keep: intents.map((intent) => intent.purchaseId).filter((id) => !deniedIds.includes(id)),
					batchId: call.body.batchId,
					heldUntil: '2026-09-18T12:02:00Z',
				},
			},
		};
	};

function nextActionsOf(purchaseId: string): unknown[] {
	return purchaseUpdates
		.filter((update) => update.where.id === purchaseId)
		.map((update) => (update.data.NextAction as { create: { requestedAction: string } }).create.requestedAction);
}

beforeAll(() => {
	quorum = [quorumKey(), quorumKey(), quorumKey()];
	outsider = quorumKey();
});

beforeEach(async () => {
	jest.clearAllMocks();
	purchaseUpdates.length = 0;
	transactionUpdates.length = 0;
	hotWalletUpdates.length = 0;
	cosignCalls.length = 0;
	process.env.EXCHAIN_COSIGN_API_KEY = 'node-token-secret';

	agentWallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: AGENT_WORDS } });
	await agentWallet.init();
	agentAddress = (await agentWallet.getUnusedAddresses())[0];
	const seller = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: SELLER_WORDS } });
	await seller.init();
	sellerAddress = (await seller.getUnusedAddresses())[0];
	mockSignTx.mockImplementation((tx, partial) => agentWallet.signTx(tx, partial));
	mockSubmitTx.mockImplementation(async (tx) => resolveTxHash(tx));

	agentUtxos = [50n, 10n].map((ada, outputIndex) => ({
		input: { txHash: '11'.repeat(32), outputIndex },
		output: { address: agentAddress, amount: [{ unit: 'lovelace', quantity: (ada * ADA).toString() }] },
	}));

	script = deriveSmartWalletScript({
		owner: '99'.repeat(28),
		stakeKeyHash: null,
		quorumVkhs: quorum.map((member) => member.vkh),
		threshold: 2,
		network: 'preprod',
	});
	const lovelaceMap = (quantity: bigint) => new Map([['', new Map([['', quantity]])]]);
	const datum: WalletDatum = {
		agent: resolvePaymentKeyHash(agentAddress),
		limit: lovelaceMap(8_000n * ADA),
		periodLength: 86_400_000n,
		periodStart: BigInt(Date.now() - 60 * 60_000),
		spentInPeriod: lovelaceMap(0n),
		minBalanceLovelace: 2n * ADA,
	};
	walletUtxo = {
		input: { txHash: '22'.repeat(32), outputIndex: 0 },
		output: {
			address: script.address,
			amount: [
				{ unit: 'lovelace', quantity: (5_000n * ADA).toString() },
				{ unit: `${script.policyId}${tokenName}`, quantity: '1' },
			],
			plutusData: serializeData(walletDatumData(datum)),
		},
	};
	guarded = {
		id: 'guarded-1',
		hotWalletId: 'wallet-1',
		walletAddress: script.address,
		stateToken: `${script.policyId}.${tokenName}`,
		scriptHash: script.policyId,
		ownerKeyHash: '99'.repeat(28),
		quorumKeyHashes: quorum.map((member) => member.vkh),
		quorumThreshold: 2,
		cosignBaseUrl: 'https://cosign.test',
		cosignTokenRef: 'EXCHAIN_COSIGN_API_KEY',
		exchainWalletId: 'wal_01J9XK3M4N5P6Q7R8S9T0V1W2Z',
		nodeId: 'node-1',
		orgId: 'org-1',
	};
	const { DEFAULT_PROTOCOL_PARAMETERS } = await import('@meshsdk/core');
	provider = {
		fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
		fetchAddressUTxOs: async (address: string) => (address === script.address ? [walletUtxo] : agentUtxos),
		fetchUTxOs: async (txHash: string, index?: number) =>
			[walletUtxo, ...agentUtxos].filter(
				(utxo) => utxo.input.txHash === txHash && (index == null || utxo.input.outputIndex === index),
			),
		evaluateTx: async () => [{ index: 0, tag: 'SPEND', budget: { mem: 600_000, steps: 250_000_000 } }],
	};
});

afterEach(() => {
	delete process.env.EXCHAIN_COSIGN_API_KEY;
});

describe('batch-payments from a guarded wallet', () => {
	it('co-signs the frozen body, merges the quorum witnesses, then signs and submits', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([paymentSource([purchase(1), purchase(2), purchase(3)])]);
		answerWith([allow()]);

		await batchLatestPaymentEntriesV2();

		expect(cosignCalls).toHaveLength(1);
		const [call] = cosignCalls;
		expect(call.url).toBe('https://cosign.test/v1/cosign');
		expect(call.headers.Authorization).toBe('Bearer node-token-secret');
		expect(call.headers['Idempotency-Key']).toBe(call.body.batchId);
		expect(call.body.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(call.body.walletUtxoRef).toBe(`${'22'.repeat(32)}#0`);
		expect(call.body.context).toMatchObject({ nodeId: 'node-1', orgId: 'org-1' });
		const intents = call.body.intents as Array<Record<string, unknown>>;
		expect(intents.map((intent) => [intent.purchaseId, intent.outputIndex])).toEqual([
			['purchase-1', 1],
			['purchase-2', 2],
			['purchase-3', 3],
		]);
		for (const intent of intents) {
			expect(intent.counterparty).toBe(`sellerVkeyHash:${resolvePaymentKeyHash(sellerAddress)}`);
			expect(intent.jobHash).toMatch(/^blake2b_256:[0-9a-f]{64}$/);
			expect(intent).toMatchObject({ amount: (199n * ADA).toString(), asset: 'lovelace' });
		}

		expect(mockSignTx).toHaveBeenCalledTimes(1);
		const [cosignedTx, partialSign] = mockSignTx.mock.calls[0];
		expect(partialSign).toBe(true);
		const tx = deserializeTx(cosignedTx);
		const body = tx.body();
		expect(body.toCbor()).toBe(call.body.txBodyHex);
		expect(tx.witnessSet().vkeys()?.values()).toHaveLength(2);

		const inputs = body
			.inputs()
			.values()
			.map((input) => `${input.transactionId()}#${input.index()}`);
		expect(inputs).toContain(`${'22'.repeat(32)}#0`);
		const redeemers = tx.witnessSet().redeemers()?.values() ?? [];
		expect(redeemers).toHaveLength(1);
		expect(redeemers[0].data().asConstrPlutusData()?.getAlternative()).toBe(BigInt(SmartWalletAction.AgentSpend));

		const outputs = body.outputs();
		expect(outputs[0].address().toBech32()).toBe(script.address);
		expect(outputs[0].amount().multiasset()?.size).toBe(1);
		expect(outputs[0].amount().coin()).toBe((5_000n - 3n * 199n) * ADA);
		const nextDatum = parseWalletDatum(deserializeDatum(outputs[0].datum()!.asInlineData()!.toCbor()));
		expect(nextDatum.spentInPeriod.get('')?.get('')).toBe(3n * 199n * ADA);
		for (const index of [1, 2, 3]) {
			expect(outputs[index].address().toBech32()).toBe(ESCROW_ADDRESS);
			expect(outputs[index].amount().coin()).toBe(199n * ADA);
		}
		expect(outputs[4].address().toBech32()).toBe(agentAddress);
		expect(outputs[4].amount().coin()).toBe(5n * ADA);
		expect(body.collateral()?.values()).toHaveLength(1);
		expect(
			body
				.requiredSigners()
				?.values()
				.map((hash) => hash.toCore())
				.sort(),
		).toEqual([resolvePaymentKeyHash(agentAddress), ...quorum.map((member) => member.vkh)].sort());
		expect(body.validityStartInterval()).toBeDefined();
		expect(body.ttl()).toBeDefined();

		const intended = transactionUpdates.find((update) => update.data.intendedTxHash != null);
		expect(intended?.data).toMatchObject({
			intendedTxHash: resolveTxHash(cosignedTx),
			invalidHereafterSlot: BigInt(body.ttl()!),
		});
		expect(prismaMock.transaction.update.mock.invocationCallOrder[transactionUpdates.indexOf(intended!)]).toBeLessThan(
			mockSubmitTx.mock.invocationCallOrder[0],
		);
		expect(mockSignTx.mock.invocationCallOrder[0]).toBeLessThan(mockSubmitTx.mock.invocationCallOrder[0]);
		for (const index of [1, 2, 3]) {
			expect(nextActionsOf(`purchase-${index}`)).toEqual([PurchasingAction.FundsLockingInitiated]);
		}
		expect(last(transactionUpdates)?.data).toEqual({ txHash: resolveTxHash(cosignedTx) });
	});

	it('drops the members outside rebuild.keep, records the verdict and rebuilds once under the same batchId', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([paymentSource([purchase(1), purchase(2), purchase(3)])]);
		answerWith([memberDenied(['purchase-2']), allow()]);
		const before = Date.now();

		await batchLatestPaymentEntriesV2();

		expect(cosignCalls).toHaveLength(2);
		expect(cosignCalls[1].body.batchId).toBe(cosignCalls[0].body.batchId);
		expect(cosignCalls[1].body.txBodyHex).not.toBe(cosignCalls[0].body.txBodyHex);
		expect((cosignCalls[1].body.intents as Array<{ purchaseId: string }>).map((intent) => intent.purchaseId)).toEqual([
			'purchase-1',
			'purchase-3',
		]);

		expect(nextActionsOf('purchase-2')).toEqual([
			PurchasingAction.FundsLockingInitiated,
			PurchasingAction.FundsLockingRequested,
		]);
		const denied = last(purchaseUpdates.filter((update) => update.where.id === 'purchase-2'))!.data;
		expect(denied.CurrentTransaction).toEqual({ disconnect: true });
		expect(denied.cosignDenied).toMatchObject({
			code: 'daily_outflow',
			reasonEnglish: 'This would take the day over the mandate.',
			retryAfterSec: 3600,
			decisionId: 'dec_01J9XK3M4N5P6Q7R8S9T0V1DNY',
		});
		const retryAt = (denied.cosignDenied as { retryAt: number }).retryAt;
		expect(retryAt).toBeGreaterThanOrEqual(before + 3_600_000);

		expect(mockSignTx).toHaveBeenCalledTimes(1);
		expect(deserializeTx(mockSignTx.mock.calls[0][0]).body().toCbor()).toBe(cosignCalls[1].body.txBodyHex);
		expect(mockSubmitTx).toHaveBeenCalledTimes(1);
		expect(nextActionsOf('purchase-1')).toEqual([PurchasingAction.FundsLockingInitiated]);
		expect(nextActionsOf('purchase-3')).toEqual([PurchasingAction.FundsLockingInitiated]);
	});

	it('skips a denied purchase until its retryAt', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([]);
		await batchLatestPaymentEntriesV2();
		const where = (
			mockPaymentSourceFindMany.mock.calls[0][0] as {
				include: { PurchaseRequests: { where: { OR: Array<Record<string, unknown>> } } };
			}
		).include.PurchaseRequests.where;
		expect(where.OR[1]).toMatchObject({ cosignDenied: { path: ['retryAt'] } });
		expect((where.OR[1].cosignDenied as { lte: number }).lte).toBeLessThanOrEqual(Date.now());
	});

	it('aborts on a second member denial: nothing signed, the wallet is released', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([paymentSource([purchase(1), purchase(2), purchase(3)])]);
		answerWith([memberDenied(['purchase-2']), memberDenied(['purchase-3'])]);

		await batchLatestPaymentEntriesV2();

		expect(cosignCalls).toHaveLength(2);
		expect(mockSignTx).not.toHaveBeenCalled();
		expect(mockSubmitTx).not.toHaveBeenCalled();
		expect(last(nextActionsOf('purchase-2'))).toBe(PurchasingAction.FundsLockingRequested);
		expect(last(nextActionsOf('purchase-1'))).toBe(PurchasingAction.WaitingForManualAction);
		expect(last(transactionUpdates)?.data).toEqual({ status: TransactionStatus.RolledBack });
		expect(last(hotWalletUpdates)?.data).toEqual({ lockedAt: null, PendingTransaction: { disconnect: true } });
	});

	it('fails every purchase with the code on a batch-level denial and logs the alarm with its decision id', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([paymentSource([purchase(1), purchase(2)])]);
		answerWith([
			(call, bodyHash, requiredSigners) => ({
				status: 409,
				body: {
					decisionId: 'dec_01J9XK3M4N5P6Q7R8S9T0ALARM',
					txBodyHash: `blake2b_256:${bodyHash}`,
					requiredSigners,
					denied: 'body_mismatch',
					reasonEnglish: 'The transaction body does not match the declared purchases.',
					alarm: true,
					members: (call.body.intents as Array<{ purchaseId: string; outputIndex: number }>).map((intent) => ({
						purchaseId: intent.purchaseId,
						outputIndex: intent.outputIndex,
						verdict: 'not_evaluated',
					})),
				},
			}),
		]);

		await batchLatestPaymentEntriesV2();

		expect(cosignCalls).toHaveLength(1);
		expect(mockSignTx).not.toHaveBeenCalled();
		expect(mockErrorLog).toHaveBeenCalledWith(
			'co-sign denied the whole batch',
			expect.objectContaining({ decisionId: 'dec_01J9XK3M4N5P6Q7R8S9T0ALARM', code: 'body_mismatch', alarm: true }),
		);
		for (const id of ['purchase-1', 'purchase-2']) {
			const failed = last(purchaseUpdates.filter((update) => update.where.id === id))!.data;
			expect(failed.NextAction).toMatchObject({
				create: {
					requestedAction: PurchasingAction.WaitingForManualAction,
					errorNote: expect.stringContaining('body_mismatch'),
				},
			});
			expect(failed.cosignDenied).toBeUndefined();
		}
	});

	it('retries a quorum outage per RETRY_CONFIG, then requeues and releases the wallet', async () => {
		jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'performance', 'Date'] });
		try {
			mockPaymentSourceFindMany.mockResolvedValue([paymentSource([purchase(1)])]);
			answerWith([
				() => ({
					status: 503,
					body: { error: 'quorum_unavailable', reachable: 1, threshold: 2, retryAfterSec: 5 },
				}),
			]);

			const run = batchLatestPaymentEntriesV2();
			for (let i = 0; i < 200 && cosignCalls.length < CONSTANTS.RETRY_CONFIG.MAX_RETRIES; i++) {
				await jest.advanceTimersByTimeAsync(CONSTANTS.RETRY_CONFIG.MAX_DELAY_MS);
			}
			await run;
		} finally {
			jest.useRealTimers();
		}

		expect(cosignCalls).toHaveLength(CONSTANTS.RETRY_CONFIG.MAX_RETRIES);
		expect(new Set(cosignCalls.map((call) => call.body.batchId)).size).toBe(1);
		expect(mockSignTx).not.toHaveBeenCalled();
		const requeued = last(purchaseUpdates.filter((update) => update.where.id === 'purchase-1'))!.data;
		expect(requeued.NextAction).toMatchObject({
			create: { requestedAction: PurchasingAction.FundsLockingRequested, errorType: null },
		});
		expect(requeued.cosignDenied).toBeUndefined();
		expect(last(hotWalletUpdates)?.data).toEqual({ lockedAt: null, PendingTransaction: { disconnect: true } });
	});

	it.each([
		['a different txBodyHash', allow(() => ({ txBodyHash: `blake2b_256:${'00'.repeat(32)}` }))],
		['requiredSigners missing a quorum key', allow((_hash, signers) => ({ requiredSigners: signers.slice(0, -1) }))],
		[
			'a witness from outside the quorum',
			allow((hash) => ({ witnessSetHex: witnessSetHex(hash, [quorum[0], outsider]) })),
		],
		[
			'a witness that does not verify',
			allow((hash) => ({ witnessSetHex: witnessSetHex(hash, quorum.slice(0, 2), true) })),
		],
		['fewer witnesses than the threshold', allow((hash) => ({ witnessSetHex: witnessSetHex(hash, [quorum[0]]) }))],
	])('never signs an approval carrying %s', async (_label, answer) => {
		mockPaymentSourceFindMany.mockResolvedValue([paymentSource([purchase(1)])]);
		answerWith([answer]);

		await batchLatestPaymentEntriesV2();

		expect(cosignCalls).toHaveLength(1);
		expect(mockSignTx).not.toHaveBeenCalled();
		expect(mockSubmitTx).not.toHaveBeenCalled();
		expect(mockErrorLog).toHaveBeenCalledWith(
			'co-sign answer rejected; the batch is aborted and nothing is signed',
			expect.objectContaining({ batchId: cosignCalls[0].body.batchId }),
		);
		expect(transactionUpdates.some((update) => update.data.intendedTxHash != null)).toBe(false);
		expect(last(hotWalletUpdates)?.data).toEqual({ lockedAt: null, PendingTransaction: { disconnect: true } });
	});

	it('leaves an unguarded wallet on the existing path with no co-sign call', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([paymentSource([purchase(1)], false)]);
		answerWith([allow()]);

		await batchLatestPaymentEntriesV2();

		expect(cosignCalls).toHaveLength(0);
	});
});
