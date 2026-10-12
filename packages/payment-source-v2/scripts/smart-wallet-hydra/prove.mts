/**
 * Preprod proof: a guarded smart wallet moves into an open Hydra head, pays a
 * purchase there with the quorum's co-signatures, and moves back to L1. Every
 * service step goes through the payment node HTTP API. Only the owner's
 * actions (mint, and signing each move) happen here, because the owner key
 * never reaches the node.
 *
 * Needs: the service on SW_API (default http://127.0.0.1:3011), an open head,
 * and the mock co-signer (mock.mts). Each stage is idempotent and records what
 * it did in .state/prove.json and .state/evidence.ndjson.
 *
 *   pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-hydra/prove.mts <stage>
 *
 * Stages: fund-seller, mint, register, attach, topup, deposit, purchase <label>,
 * withdraw, status.
 */
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { assetValueData } from '../../src/smart-wallet/wallet';
import { buildMintWalletTx, loadSmartWalletScript } from '../../src/smart-wallet/wallet-lifecycle';
import {
	ADA,
	blockfrostKey,
	evidence,
	loadWallets,
	log,
	NETWORK,
	provider,
	readState,
	waitFor,
	waitForL1Tx,
	writeState,
} from './lib.mjs';

const API = `${process.env.SW_API ?? 'http://127.0.0.1:3011'}/api/v1`;
const ADMIN_KEY = process.env.ADMIN_KEY?.trim();
if (!ADMIN_KEY) throw new Error('ADMIN_KEY is not set; export the proof env first');

const WALLET_FUND_LOVELACE = 100n * ADA;
const WALLET_PERIOD_LIMIT_LOVELACE = 50n * ADA;
const WALLET_MIN_BALANCE_LOVELACE = 5n * ADA;
const WALLET_PERIOD_MS = 86_400_000n;
const SELLER_FUND_LOVELACE = 25n * ADA;
const THRESHOLD = 2;

type ProveState = {
	sellerFundTx?: string;
	wallet?: { address: string; policyId: string; stateTokenName: string; mintTxHash: string };
	agentIdentifier?: string;
	hotWalletId?: string;
	hydraHeadId?: string;
	purchases?: Record<string, { purchaseId: string; blockchainIdentifier: string }>;
};

const state = readState<ProveState>('prove') ?? {};
// Merge into what is on disk: two stages may run at once.
const save = () => writeState('prove', { ...(readState<ProveState>('prove') ?? {}), ...state });

async function api<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
	const request = () =>
		fetch(`${API}${route}`, {
			method,
			headers: { token: ADMIN_KEY!, 'content-type': 'application/json' },
			body: body == null ? undefined : JSON.stringify(body),
		});
	// Reads ride out a dev-server restart; a write is never sent twice.
	let response: Response | null = null;
	for (let attempt = 0; response == null; attempt++) {
		try {
			response = await request();
		} catch (error) {
			if (method !== 'GET' || attempt >= 30) throw error;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${route} ${response.status}: ${text}`);
	return (JSON.parse(text) as { data: T }).data;
}

async function wallets() {
	const all = await loadWallets();
	const address = async (role: keyof typeof all) => await all[role].getChangeAddress();
	return { all, address };
}

/** Owner and quorum keys of this proof, and the script they derive. */
async function script() {
	const { all, address } = await wallets();
	const quorumVkhs = [
		resolvePaymentKeyHash(await address('quorum1')),
		resolvePaymentKeyHash(await address('quorum2')),
		resolvePaymentKeyHash(await address('quorum3')),
	];
	const ownerAddress = await address('owner');
	return {
		all,
		ownerAddress,
		agentAddress: await address('agent'),
		quorumVkhs,
		script: loadSmartWalletScript({ ownerAddress, quorumVkhs, threshold: THRESHOLD, network: NETWORK }),
	};
}

async function hotWallet() {
	if (state.hotWalletId != null && state.hydraHeadId != null) return;
	const heads = await api<{
		heads: Array<{ id: string; status: string; LocalParticipant: { walletId: string } | null }>;
	}>('GET', '/hydra/head?limit=10');
	const head = heads.heads.find((entry) => entry.LocalParticipant != null);
	if (head?.LocalParticipant == null) throw new Error('no Hydra head with a local participant');
	state.hydraHeadId = head.id;
	state.hotWalletId = head.LocalParticipant.walletId;
	save();
}

async function escrowAddress(): Promise<string> {
	const sources = await api<{ PaymentSources: Array<{ smartContractAddress: string }> }>(
		'GET',
		'/payment-source?take=10',
	);
	const address = sources.PaymentSources[0]?.smartContractAddress;
	if (address == null) throw new Error('no payment source');
	return address;
}

/** The service's Selling hot wallet: it registers the agent and is the purchase seller. */
async function sellerWallet(): Promise<{ walletVkey: string; walletAddress: string }> {
	const sources = await api<{ PaymentSources: Array<{ id: string }> }>('GET', '/payment-source?take=10');
	const sourceId = sources.PaymentSources[0]?.id;
	if (sourceId == null) throw new Error('no payment source');
	const list = await api<{ Wallets: Array<{ walletVkey: string; walletAddress: string }> }>(
		'GET',
		`/wallet/list?paymentSourceId=${sourceId}&walletType=Selling&take=5`,
	);
	const seller = list.Wallets[0];
	if (seller == null) throw new Error('no selling wallet');
	return seller;
}

// ------------------------------------------------------------------ stages

/** The seller hot wallet pays its own registry mint, so it needs a little ADA. */
async function fundSeller(): Promise<void> {
	if (state.sellerFundTx != null) return log('fund-seller', `already sent ${state.sellerFundTx}`);
	const { all } = await wallets();
	const seller = await sellerWallet();
	const { MeshTxBuilder } = await import('@meshsdk/core');
	const owner = all.owner;
	const tx = await new MeshTxBuilder({ fetcher: provider, submitter: provider })
		.txOut(seller.walletAddress, [{ unit: 'lovelace', quantity: SELLER_FUND_LOVELACE.toString() }])
		.changeAddress(await owner.getChangeAddress())
		.selectUtxosFrom(await owner.getUtxos())
		.setNetwork(NETWORK)
		.complete();
	const txHash = await owner.submitTx(await owner.signTx(tx));
	state.sellerFundTx = txHash;
	save();
	await waitForL1Tx(txHash);
	evidence({ stage: 'fund-seller', txHash, to: seller.walletAddress });
	log('fund-seller', `confirmed ${txHash}`);
}

async function mint(): Promise<void> {
	if (state.wallet != null) return log('mint', `wallet ${state.wallet.address} already minted`);
	const { all, ownerAddress, agentAddress, script: wallet } = await script();
	const built = await buildMintWalletTx({
		provider,
		rpcApiKey: blockfrostKey,
		network: NETWORK,
		wallet,
		ownerAddress,
		ownerUtxos: await all.owner.getUtxos(),
		fundLovelace: WALLET_FUND_LOVELACE,
		datum: {
			agent: resolvePaymentKeyHash(agentAddress),
			limit: assetValueData([{ unit: 'lovelace', quantity: WALLET_PERIOD_LIMIT_LOVELACE.toString() }]),
			periodLength: WALLET_PERIOD_MS,
			periodStart: BigInt(Date.now()),
			spentInPeriod: assetValueData([{ unit: 'lovelace', quantity: '0' }]),
			minBalanceLovelace: WALLET_MIN_BALANCE_LOVELACE,
		},
	});
	// The token name is the wallet's identity: keep it before submitting.
	state.wallet = {
		address: wallet.address,
		policyId: wallet.policyId,
		stateTokenName: built.tokenName,
		mintTxHash: built.txHash,
	};
	save();
	await all.owner.submitTx(await all.owner.signTx(built.unsignedTx, true));
	await waitForL1Tx(built.txHash);
	evidence({ stage: 'mint', txHash: built.txHash, address: wallet.address, policyId: wallet.policyId });
	log('mint', `confirmed ${built.txHash}`);
}

type RegistryAsset = { state: string; agentIdentifier: string | null; name: string };

async function register(): Promise<void> {
	if (state.agentIdentifier != null) return log('register', `agent ${state.agentIdentifier}`);
	const sellerVkey = (await sellerWallet()).walletVkey;
	const name = 'sw-hydra-proof-agent';
	const existing = await api<{ Assets: RegistryAsset[] }>(
		'GET',
		'/registry?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=10',
	);
	if (!existing.Assets.some((asset) => asset.name === name)) {
		await api('POST', '/registry', {
			network: 'Preprod',
			sellingWalletVkey: sellerVkey,
			name,
			description: 'Guarded wallet in Hydra preprod proof',
			Tags: ['proof'],
			ExampleOutputs: [],
			Capability: { name: 'proof', version: '1.0.0' },
			Author: { name: 'Masumi' },
			apiBaseUrl: 'https://example.com',
			supportedPaymentSources: [
				{
					chain: 'Cardano',
					network: 'Preprod',
					paymentSourceType: 'Web3CardanoV2',
					address: await escrowAddress(),
					pricing: { pricingType: 'Dynamic' },
				},
			],
		});
	}
	const agent = await waitFor('the registry mint', async () => {
		const list = await api<{ Assets: RegistryAsset[] }>(
			'GET',
			'/registry?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=10',
		);
		const asset = list.Assets.find((entry) => entry.name === name);
		log('register', `state ${asset?.state ?? 'none'}`);
		return asset?.agentIdentifier != null && asset.state === 'RegistrationConfirmed' ? asset : null;
	});
	state.agentIdentifier = agent.agentIdentifier!;
	save();
	evidence({ stage: 'register', agentIdentifier: state.agentIdentifier });
}

async function attach(): Promise<void> {
	await hotWallet();
	if (state.wallet == null) throw new Error('mint first');
	const { ownerAddress, quorumVkhs } = await script();
	const existing = await api<{ GuardedWallet: object | null }>(
		'GET',
		`/wallet/guarded?hotWalletId=${state.hotWalletId}`,
	).catch(() => null);
	if (existing?.GuardedWallet != null) return log('attach', 'already attached');
	const record = await api<unknown>('POST', '/wallet/guarded', {
		hotWalletId: state.hotWalletId,
		ownerAddress,
		quorumVkhs,
		threshold: THRESHOLD,
		stateTokenName: state.wallet.stateTokenName,
	});
	evidence({ stage: 'attach', record: JSON.stringify(record) });
	log('attach', JSON.stringify(record));
}

/** In-head ADA for the agent: the collateral every guarded script spend in the head needs. */
async function topup(): Promise<void> {
	await hotWallet();
	const result = await api('POST', '/hydra/head/topup', {
		headId: state.hydraHeadId,
		assetFilter: 'ada-only',
		exactAmount: (20n * ADA).toString(),
	});
	log('topup', JSON.stringify(result));
	await waitFor('the agent top-up in the head', async () => {
		const list = await api<{ topups: Array<{ status: string; depositTxHash: string | null }> }>(
			'GET',
			`/hydra/head/topup?headId=${state.hydraHeadId}&limit=1`,
		);
		log('topup', `status ${list.topups[0]?.status}`);
		return list.topups[0]?.status === 'Confirmed' ? list.topups[0] : null;
	});
	evidence({ stage: 'topup', headId: state.hydraHeadId ?? null });
}

type TransferView = { id: string; status: string; txHash: string; failureReason: string | null };

async function ownerSign(unsignedTx: string): Promise<string> {
	const { all } = await wallets();
	return await all.owner.signTx(unsignedTx, true);
}

async function status(): Promise<{ location: string; walletUtxoRef: string | null; transfers: TransferView[] }> {
	await hotWallet();
	const result = await api<{ location: string; walletUtxoRef: string | null; transfers: TransferView[] }>(
		'GET',
		`/wallet/guarded/hydra?hotWalletId=${state.hotWalletId}`,
	);
	log('status', JSON.stringify(result));
	return result;
}

async function move(direction: 'deposit' | 'withdraw', target: 'L2' | 'L1'): Promise<void> {
	await hotWallet();
	const prepared = await api<{ transfer: TransferView; unsignedTx: string }>(
		'POST',
		`/wallet/guarded/hydra/${direction}`,
		direction === 'deposit'
			? { hotWalletId: state.hotWalletId, hydraHeadId: state.hydraHeadId }
			: { hotWalletId: state.hotWalletId },
	);
	log(direction, `prepared ${prepared.transfer.id} tx ${prepared.transfer.txHash}`);
	const signedTx = await ownerSign(prepared.unsignedTx);
	const submitted = await api<{ transfer: TransferView }>('POST', `/wallet/guarded/hydra/${direction}/submit`, {
		transferId: prepared.transfer.id,
		signedTx,
	});
	log(direction, `submitted: ${JSON.stringify(submitted.transfer)}`);
	if (submitted.transfer.status === 'Failed')
		throw new Error(`${direction} failed: ${submitted.transfer.failureReason}`);
	const settled = await waitFor(`the wallet on ${target}`, async () => {
		const now = await status();
		return now.location === target ? now : null;
	});
	evidence({ stage: direction, txHash: prepared.transfer.txHash, walletUtxoRef: settled.walletUtxoRef });
}

type PurchaseView = {
	id: string;
	onChainState: string | null;
	NextAction: { requestedAction: string; errorType: string | null; errorNote: string | null };
	CurrentTransaction: { txHash: string | null; layer?: string } | null;
};

async function purchase(label: string, lovelace: bigint): Promise<void> {
	if (state.agentIdentifier == null) throw new Error('register first');
	const sellerVkey = (await sellerWallet()).walletVkey;
	state.purchases ??= {};
	let entry = state.purchases[label];
	if (entry == null) {
		const inputHash = Buffer.from(`${label}-${Date.now()}`).toString('hex').padEnd(64, '0').slice(0, 64);
		const identifierFromPurchaser = Buffer.from(label).toString('hex').padEnd(20, '0').slice(0, 20);
		const payment = await api<{
			blockchainIdentifier: string;
			payByTime: string;
			submitResultTime: string;
			unlockTime: string;
			externalDisputeUnlockTime: string;
		}>('POST', '/payment', {
			network: 'Preprod',
			agentIdentifier: state.agentIdentifier,
			inputHash,
			identifierFromPurchaser,
			RequestedFunds: [{ unit: '', amount: lovelace.toString() }],
			supportedPaymentSourceIndex: 0,
			// The head's payByTime check needs room; results are never submitted in this proof.
			payByTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			submitResultTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
		});
		const created = await api<{ id: string }>('POST', '/purchase', {
			network: 'Preprod',
			agentIdentifier: state.agentIdentifier,
			blockchainIdentifier: payment.blockchainIdentifier,
			sellerVkey,
			inputHash,
			identifierFromPurchaser,
			payByTime: payment.payByTime,
			submitResultTime: payment.submitResultTime,
			unlockTime: payment.unlockTime,
			externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
			Amounts: [{ unit: '', amount: lovelace.toString() }],
			supportedPaymentSourceIndex: 0,
		});
		entry = { purchaseId: created.id, blockchainIdentifier: payment.blockchainIdentifier };
		state.purchases[label] = entry;
		save();
	}
	const settled = await waitFor(`purchase ${label} to settle`, async () => {
		const list = await api<{ Purchases: PurchaseView[] }>(
			'GET',
			'/purchase?network=Preprod&limit=20&filterPaymentSourceType=Web3CardanoV2',
		);
		const row = list.Purchases.find((item) => item.id === entry.purchaseId);
		log(
			'purchase',
			`${label}: ${row?.onChainState ?? 'none'} / ${row?.NextAction.requestedAction} ${row?.NextAction.errorNote ?? ''}`,
		);
		if (row == null) return null;
		if (row.onChainState === 'FundsLocked') return row;
		return row.NextAction.requestedAction === 'WaitingForManualAction' ? row : null;
	});
	evidence({
		stage: `purchase:${label}`,
		purchaseId: entry.purchaseId,
		onChainState: settled.onChainState,
		nextAction: settled.NextAction.requestedAction,
		errorType: settled.NextAction.errorType,
		errorNote: settled.NextAction.errorNote,
		txHash: settled.CurrentTransaction?.txHash ?? null,
	});
}

const [stage, arg, adaArg] = process.argv.slice(2);
const stages: Record<string, () => Promise<unknown>> = {
	'fund-seller': fundSeller,
	mint,
	register,
	attach,
	topup,
	deposit: () => move('deposit', 'L2'),
	purchase: () => purchase(arg ?? 'allowed', BigInt(adaArg ?? '10') * ADA),
	withdraw: () => move('withdraw', 'L1'),
	status,
};
const run = stages[stage ?? ''];
if (run == null) throw new Error(`stage must be one of: ${Object.keys(stages).join(', ')}`);
await run();
process.exit(0);
