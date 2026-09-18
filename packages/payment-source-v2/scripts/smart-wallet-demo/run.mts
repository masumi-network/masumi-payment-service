/**
 * MAS-596 demo: one preprod guarded smart wallet locking escrow funds through
 * `POST /v1/cosign`, one deny and allows measured batched vs single-item.
 *
 * Run from the repository root, so the root tsconfig paths and `.env` apply:
 *
 *   pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-demo/run.mts <command>
 *
 *   init           create demo keys, synthetic purchases and state; print what to fund
 *   mint           mint the state token and fund the wallet from the owner key
 *   deny           build a lock above the co-sign policy cap; expect a 409; submit nothing
 *   allow-batched  lock the synthetic purchases in one guarded transaction
 *   allow-single   lock the same purchases one guarded transaction each
 *   report         read fees from chain; write evidence/<ISO>/result.json and SUMMARY.md
 *   mock           serve the mock co-signer and its decision page on SMART_WALLET_DEMO_MOCK_PORT
 *   sweep          owner sweeps the wallet and burns the state token
 *   all            mint (if needed), deny, allow-batched, allow-single, report
 *
 * With EXCHAIN_COSIGN_URL unset, every command talks to an in-process mock.
 * Preprod only. Synthetic locks stay in escrow; they are test tADA, not reclaimed here.
 */
import {
	config,
	WALLET_MIN_BALANCE_LOVELACE,
	WALLET_PERIOD_MS,
	AGENT_COLLATERAL_SPLIT_LOVELACE,
	walletPeriodLimitLovelace,
} from './demo-config';
import { calculateMinUtxo } from '@/utils/min-utxo';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { MeshTxBuilder, MeshWallet, resolvePaymentKeyHash, resolveTxHash } from '@meshsdk/core';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { lovelaceFromUtxo } from '../../src/builders/batch-helpers';
import { createDatumFromBlockchainIdentifierV2 } from '../../src/datum-builder';
import {
	CosignTransportError,
	mergeCosignWitnesses,
	requestCosign,
	type CosignConfig,
	type CosignRequest,
} from './cosign-proposal-client';
import {
	buildGuardedLockTx,
	GuardedTxTooLargeError,
	loadV2ProtocolParameters,
	type GuardedLockBuild,
} from '../../src/smart-wallet/guarded-lock-builder';
import { assetValueData } from '../../src/smart-wallet/wallet';
import {
	buildMintWalletTx,
	buildOwnerSweepTx,
	fetchWalletUtxo,
	readWalletDatum,
} from '../../src/smart-wallet/wallet-lifecycle';
import { memberVkhOf, startMockCosignServer } from './cosign-mock';

import {
	ADA,
	ada,
	agentMnemonic,
	blockfrostKey,
	brewMnemonic,
	DECISIONS_FILE,
	escrowAddress,
	event,
	firstAddress,
	hex,
	liveWallet,
	loadState,
	log,
	MOCK_MAX_VALIDITY_SLOTS,
	NETWORK,
	ownerMnemonic,
	provider,
	reconcileApprovedRuns,
	RESERVATION_TTL_SECONDS,
	resolveInputLovelace,
	saveState,
	sha256,
	signAndSubmit,
	smartWallet,
	STATE_FILE,
	waitForConfirmation,
	waitForWalletAt,
	wallet,
	withCosigner,
	type DemoState,
	type RunKind,
	type RunRecord,
	type SyntheticPurchase,
} from './demo-context.mjs';
import { report } from './demo-report.mjs';
// ---------------------------------------------------------------- commands

async function init(): Promise<void> {
	if (fs.existsSync(STATE_FILE)) {
		log(`state exists at ${STATE_FILE}; showing it`);
		await printFunding(loadState());
		return;
	}
	const externalCosigner = config.cosignUrl != null;
	if (externalCosigner && config.cosignQuorumVkhs.length === 0) {
		throw new Error(
			'EXCHAIN_COSIGN_QUORUM_VKHS is required when EXCHAIN_COSIGN_URL is set; the quorum is fixed at mint',
		);
	}
	const memberMnemonics = externalCosigner ? [] : [0, 1, 2].map(() => brewMnemonic());
	const quorumVkhs = externalCosigner
		? config.cosignQuorumVkhs
		: await Promise.all(memberMnemonics.map((mnemonic) => memberVkhOf(mnemonic)));

	const sellerMnemonic = brewMnemonic();
	const seller = wallet(sellerMnemonic);
	const sellerAddress = await firstAddress(seller);
	const escrow = await escrowAddress();
	const now = BigInt(Date.now());
	const hour = 60n * 60n * 1000n;
	const purchases: SyntheticPurchase[] = [];
	// Built like POST /payment does, so datum sizes match real purchases.
	for (let i = 0; i < config.purchases; i++) {
		const agentIdentifier = hex(28) + hex(28);
		const sellerId = sha256(randomUUID()) + agentIdentifier;
		const signed = await seller.signData(sha256(randomUUID()), sellerAddress);
		purchases.push({
			blockchainIdentifier: generateBlockchainIdentifier(signed.key, signed.signature, sellerId, hex(13), escrow),
			inputHash: sha256(randomUUID()),
			payByTime: String(now + 2n * hour),
			resultTime: String(now + 6n * hour),
			unlockTime: String(now + 12n * hour),
			externalDisputeUnlockTime: String(now + 24n * hour),
		});
	}

	const state: DemoState = {
		version: 1,
		createdAt: new Date().toISOString(),
		ownerMnemonic: process.env.SMART_WALLET_DEMO_OWNER_MNEMONIC?.trim() ? undefined : brewMnemonic(),
		agentMnemonic: process.env.SMART_WALLET_DEMO_AGENT_MNEMONIC?.trim() ? undefined : brewMnemonic(),
		sellerMnemonic,
		memberMnemonics,
		mockApiKey: hex(32),
		quorumVkhs,
		threshold: config.threshold,
		purchases,
		wallet: null,
		runs: [],
	};
	saveState(state);
	event('init', { purchases: purchases.length, externalCosigner, threshold: config.threshold });
	await printFunding(state);
}

async function printFunding(state: DemoState): Promise<void> {
	const owner = await firstAddress(wallet(ownerMnemonic(state)));
	const agent = await firstAddress(wallet(agentMnemonic(state)));
	const script = await smartWallet(state);
	log(`owner  (cold key, mints and sweeps):   ${owner}`);
	log(`agent  (hot key, pays fees + collateral): ${agent}`);
	log(`wallet (script, derived from params):  ${script.address}`);
	log(`quorum: ${state.threshold} of ${state.quorumVkhs.length} — ${state.quorumVkhs.join(', ')}`);
	log(
		`fund the owner with at least ${ada(config.fundLovelace + 15n * ADA)} and the agent with at least ${ada(30n * ADA)}`,
	);
	log('preprod faucet: https://docs.cardano.org/cardano-testnets/tools/faucet');
}

async function ensureAgentCollateral(agent: MeshWallet): Promise<void> {
	const utxos = await agent.getUtxos();
	const total = utxos.reduce((sum, utxo) => sum + lovelaceFromUtxo(utxo), 0n);
	if (total < 15n * ADA) {
		throw new Error(`agent holds ${ada(total)}; fund it with at least 30 tADA first`);
	}
	// ADR 0007 readiness shape: a >= 5 ADA collateral candidate plus a separate fee input.
	if (utxos.length >= 2 && utxos.some((utxo) => lovelaceFromUtxo(utxo) >= 5n * ADA)) return;
	const agentAddress = await firstAddress(agent);
	const protocolParameters = await loadV2ProtocolParameters(provider, blockfrostKey);
	const txBuilder = new MeshTxBuilder({ fetcher: provider });
	txBuilder.protocolParams(protocolParameters);
	const unsignedTx = await txBuilder
		.txOut(agentAddress, [{ unit: 'lovelace', quantity: AGENT_COLLATERAL_SPLIT_LOVELACE.toString() }])
		.changeAddress(agentAddress)
		.selectUtxosFrom(utxos)
		.setNetwork(NETWORK)
		.complete();
	const txHash = resolveTxHash(unsignedTx);
	log(`agent has one UTxO; splitting out a collateral reserve (${txHash})`);
	await signAndSubmit(agent, unsignedTx, txHash);
	await waitForConfirmation(txHash, 'agent collateral split');
}

async function mint(): Promise<void> {
	const state = loadState();
	if (state.wallet?.status === 'live') {
		log(`wallet already live at ${state.wallet.address}`);
		return;
	}
	if (state.wallet?.status === 'submitted') {
		await confirmMint(state);
		return;
	}
	if (state.wallet?.status === 'retired') {
		throw new Error('this demo wallet was retired; delete the .state directory to start over');
	}
	const periodLimitLovelace = walletPeriodLimitLovelace();
	const owner = wallet(ownerMnemonic(state));
	const agent = wallet(agentMnemonic(state));
	const ownerAddress = await firstAddress(owner);
	const ownerTotal = (await owner.getUtxos()).reduce((sum, utxo) => sum + lovelaceFromUtxo(utxo), 0n);
	if (ownerTotal < config.fundLovelace + 10n * ADA) {
		throw new Error(`owner holds ${ada(ownerTotal)}; fund it with at least ${ada(config.fundLovelace + 15n * ADA)}`);
	}
	await ensureAgentCollateral(agent);
	const ownerUtxos = await owner.getUtxos();
	const script = await smartWallet(state);
	const agentVkh = resolvePaymentKeyHash(await firstAddress(agent));
	const built = await buildMintWalletTx({
		provider,
		rpcApiKey: blockfrostKey,
		network: NETWORK,
		wallet: script,
		ownerAddress,
		ownerUtxos,
		fundLovelace: config.fundLovelace,
		datum: {
			agent: agentVkh,
			limit: assetValueData([{ unit: 'lovelace', quantity: periodLimitLovelace.toString() }]),
			periodLength: WALLET_PERIOD_MS,
			periodStart: BigInt(Date.now()),
			spentInPeriod: assetValueData([{ unit: 'lovelace', quantity: '0' }]),
			minBalanceLovelace: WALLET_MIN_BALANCE_LOVELACE,
		},
	});
	// Persist the seed BEFORE submitting: the token name is the wallet's identity.
	state.wallet = {
		address: script.address,
		policyId: script.policyId,
		tokenName: built.tokenName,
		seed: built.seed,
		mintTxHash: built.txHash,
		periodLimitLovelace: periodLimitLovelace.toString(),
		status: 'submitted',
	};
	saveState(state);
	try {
		await signAndSubmit(owner, built.unsignedTx, built.txHash);
	} catch (error) {
		state.wallet = null;
		saveState(state);
		throw error;
	}
	event('mint-submitted', { txHash: built.txHash, address: script.address });
	log(`mint submitted ${built.txHash}`);
	await confirmMint(state);
}

async function confirmMint(state: DemoState): Promise<void> {
	if (state.wallet == null) throw new Error('no minted wallet in state');
	const script = await smartWallet(state);
	await waitForConfirmation(state.wallet.mintTxHash, 'mint');
	const utxo = await waitForWalletAt(script, state.wallet.tokenName, state.wallet.mintTxHash);
	const datum = readWalletDatum(utxo);
	state.wallet.status = 'live';
	saveState(state);
	event('mint-confirmed', { txHash: state.wallet.mintTxHash });
	log(`wallet live at ${script.address} with ${ada(lovelaceFromUtxo(utxo))}; agent ${datum.agent}`);
}

async function guardedLock(
	state: DemoState,
	cosign: CosignConfig,
	kind: RunKind,
	purchaseIndexes: number[],
	lockLovelace: bigint,
): Promise<RunRecord> {
	const record = liveWallet(state);
	const script = await smartWallet(state);
	const agent = wallet(agentMnemonic(state));
	const agentAddress = await firstAddress(agent);
	const sellerAddress = await firstAddress(wallet(state.sellerMnemonic));
	const escrow = await escrowAddress();
	const protocolParameters = await provider.fetchProtocolParameters();
	const cosignerVkhs = state.quorumVkhs.slice(0, state.threshold);

	let indexes = purchaseIndexes;
	for (;;) {
		const walletUtxo = await fetchWalletUtxo(provider, script, record.tokenName);
		const walletDatum = readWalletDatum(walletUtxo);
		const agentUtxos = await agent.getUtxos();
		const locks = indexes.map((index) => {
			const purchase = state.purchases[index];
			const datum = createDatumFromBlockchainIdentifierV2({
				buyerAddress: agentAddress,
				buyerReturnAddress: agentAddress,
				sellerAddress,
				sellerReturnAddress: null,
				blockchainIdentifier: purchase.blockchainIdentifier,
				collateralReturnLovelace: 0n,
				inputHash: purchase.inputHash,
				resultHash: null,
				payByTime: BigInt(purchase.payByTime),
				resultTime: BigInt(purchase.resultTime),
				unlockTime: BigInt(purchase.unlockTime),
				externalDisputeUnlockTime: BigInt(purchase.externalDisputeUnlockTime),
				newCooldownTimeSeller: 0n,
				newCooldownTimeBuyer: 0n,
				state: SmartContractState.FundsLocked,
			});
			const { minUtxoLovelace } = calculateMinUtxo({
				datum: datum.value,
				nativeTokenCount: 0,
				coinsPerUtxoSize: protocolParameters.coinsPerUtxoSize,
				includeBuffers: true,
			});
			if (lockLovelace < minUtxoLovelace) {
				throw new Error(`lock of ${ada(lockLovelace)} is below the ${ada(minUtxoLovelace)} min-UTxO for this datum`);
			}
			return { address: escrow, amount: [{ unit: 'lovelace', quantity: lockLovelace.toString() }], datum: datum.value };
		});

		const tBuild0 = performance.now();
		let built: GuardedLockBuild;
		try {
			built = await buildGuardedLockTx({
				provider,
				rpcApiKey: blockfrostKey,
				network: NETWORK,
				wallet: { scriptCode: script.scriptCode, address: script.address },
				walletUtxo,
				walletDatum,
				agentAddress,
				agentUtxos,
				cosignerVkhs,
				locks,
			});
		} catch (error) {
			if (error instanceof GuardedTxTooLargeError && indexes.length > 1) {
				event('shrink', { kind, from: indexes.length, sizeBytes: error.sizeBytes });
				log(`${kind}: ${indexes.length} locks is ${error.sizeBytes} bytes; shrinking by one`);
				indexes = indexes.slice(0, -1);
				continue;
			}
			throw error;
		}
		const tFreeze = performance.now();
		const frozenAt = new Date().toISOString();
		event('frozen', { kind, txHash: built.txHash, locks: indexes.length, unsignedBytes: built.unsignedBytes });

		const request: CosignRequest = {
			version: 1,
			network: NETWORK,
			txCbor: built.unsignedTx,
			txHash: built.txHash,
			wallet: {
				address: script.address,
				stateTokenUnit: `${script.policyId}${record.tokenName}`,
				input: walletUtxo.input,
			},
			requiredSigners: cosignerVkhs,
			intent: {
				kind: 'escrow-lock',
				buyerAddress: agentAddress,
				// Must match the datum built above field for field; the co-signer decodes and compares.
				locks: indexes.map((index) => ({
					address: escrow,
					lovelace: lockLovelace.toString(),
					blockchainIdentifier: state.purchases[index].blockchainIdentifier,
					sellerAddress,
					buyerReturnAddress: agentAddress,
					sellerReturnAddress: null,
				})),
				outflowLovelace: built.outflowLovelace.toString(),
				changeAddress: agentAddress,
				validity: built.validity,
				requestedBy: 'masumi-payment-service/smart-wallet-demo',
			},
			reservationTtlSeconds: RESERVATION_TTL_SECONDS,
		};
		const tCosign0 = performance.now();
		const decision = await requestCosign(cosign, request);
		const tCosign1 = performance.now();
		const paymentValue = lockLovelace * BigInt(indexes.length);
		const run: RunRecord = {
			kind,
			purchaseIndexes: indexes,
			lockLovelace: lockLovelace.toString(),
			paymentValueLovelace: paymentValue.toString(),
			txHash: built.txHash,
			unsignedBytes: built.unsignedBytes,
			walletInput: `${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex}`,
			frozenAt,
			decision: decision.httpStatus === 200 ? 'approved' : 'denied',
			timings: {
				buildMs: Math.round(tFreeze - tBuild0),
				cosignRoundTripMs: Math.round(tCosign1 - tCosign0),
				freezeToDecisionMs: Math.round(tCosign1 - tFreeze),
			},
			submitted: false,
		};

		if (decision.httpStatus === 409) {
			run.denialCode = decision.denied.code;
			run.deniedLocks = decision.denied.locks.filter((lock) => lock.verdict === 'denied').map((lock) => lock.index);
			state.runs.push(run);
			saveState(state);
			event('denied', { kind, txHash: built.txHash, code: decision.denied.code, message: decision.denied.message });
			log(
				`${kind}: co-signer DENIED ${built.txHash.slice(0, 16)}… — ${decision.denied.code}: ${decision.denied.message}`,
			);
			return run;
		}
		if (kind === 'deny') {
			state.runs.push(run);
			saveState(state);
			throw new Error('the deny scenario was APPROVED by the co-signer; nothing was submitted, check the policy cap');
		}

		const merged = mergeCosignWitnesses(
			built.unsignedTx,
			{ txHash: built.txHash, signerVkhs: cosignerVkhs },
			decision.approved.signatures,
		);
		const signed = await agent.signTx(merged, true);
		if (resolveTxHash(signed) !== built.txHash) throw new Error('agent signature changed the frozen body');
		const tSigned = performance.now();
		state.runs.push(run);
		saveState(state);
		const submitted = await agent.submitTx(signed);
		const tSubmit = performance.now();
		if (submitted !== built.txHash) throw new Error(`node returned ${submitted}, expected ${built.txHash}`);
		run.submitted = true;
		run.timings.mergeAndSignMs = Math.round(tSigned - tCosign1);
		run.timings.freezeToSubmitMs = Math.round(tSubmit - tFreeze);
		saveState(state);
		event('submitted', { kind, txHash: built.txHash, freezeToSubmitMs: run.timings.freezeToSubmitMs });
		log(
			`${kind}: submitted ${built.txHash} — ${indexes.length} lock(s), ${built.unsignedBytes} B unsigned, freeze→submit ${run.timings.freezeToSubmitMs} ms`,
		);

		run.chain = await waitForConfirmation(built.txHash, kind);
		saveState(state);
		await waitForWalletAt(script, record.tokenName, built.txHash);
		event('confirmed', {
			kind,
			txHash: built.txHash,
			feeLovelace: run.chain.feeLovelace,
			sizeBytes: run.chain.sizeBytes,
		});
		log(`${kind}: confirmed, fee ${ada(run.chain.feeLovelace)}, ${run.chain.sizeBytes} B`);
		return run;
	}
}

function allIndexes(state: DemoState): number[] {
	return state.purchases.map((_, index) => index);
}

async function deny(state: DemoState): Promise<void> {
	const total = config.denyLockLovelace * BigInt(state.purchases.length);
	if (config.cosignUrl == null && total <= config.mockCapLovelace) {
		throw new Error('deny total must exceed SMART_WALLET_DEMO_MOCK_CAP_LOVELACE, or the mock will approve it');
	}
	await withCosigner(state, async (cosign) => {
		const run = await guardedLock(state, cosign, 'deny', allIndexes(state), config.denyLockLovelace);
		if (run.decision !== 'denied') throw new Error('expected a denial');
	});
}

async function allowBatched(state: DemoState): Promise<void> {
	await reconcileApprovedRuns(state);
	if (state.runs.some((run) => run.kind === 'allow-batched' && run.submitted)) {
		log('allow-batched already submitted; skipping');
		return;
	}
	await withCosigner(state, async (cosign) => {
		const run = await guardedLock(state, cosign, 'allow-batched', allIndexes(state), config.lockLovelace);
		if (run.decision !== 'approved') throw new Error(`batched lock was denied: ${run.denialCode}`);
	});
}

async function allowSingle(state: DemoState): Promise<void> {
	await reconcileApprovedRuns(state);
	const batched = state.runs.find((run) => run.kind === 'allow-batched' && run.submitted);
	if (batched == null) throw new Error('run allow-batched first; single-item locks reuse exactly its purchases');
	const lockLovelace = BigInt(batched.lockLovelace);
	await withCosigner(state, async (cosign) => {
		for (const index of batched.purchaseIndexes) {
			if (state.runs.some((run) => run.kind === 'allow-single' && run.submitted && run.purchaseIndexes[0] === index)) {
				continue;
			}
			const run = await guardedLock(state, cosign, 'allow-single', [index], lockLovelace);
			if (run.decision !== 'approved') throw new Error(`single lock ${index} was denied: ${run.denialCode}`);
		}
	});
}

async function mock(state: DemoState): Promise<void> {
	if (state.memberMnemonics.length === 0)
		throw new Error('this state uses an external co-signer; there is no mock quorum');
	const server = await startMockCosignServer({
		memberMnemonics: state.memberMnemonics,
		apiKey: state.mockApiKey,
		threshold: state.threshold,
		maxOutflowLovelace: config.mockCapLovelace,
		maxValiditySlots: MOCK_MAX_VALIDITY_SLOTS,
		resolveInputLovelace,
		decisionsFile: DECISIONS_FILE,
		port: config.mockPort,
	});
	log(`mock co-signer on ${server.url} (POST /v1/cosign, decisions page at /). Ctrl+C to stop.`);
	await new Promise<void>((resolve) => process.once('SIGINT', resolve));
	await server.close();
}

async function sweep(state: DemoState): Promise<void> {
	const record = liveWallet(state);
	const owner = wallet(ownerMnemonic(state));
	const ownerAddress = await firstAddress(owner);
	const script = await smartWallet(state);
	const walletUtxo = await fetchWalletUtxo(provider, script, record.tokenName);
	const built = await buildOwnerSweepTx({
		provider,
		rpcApiKey: blockfrostKey,
		network: NETWORK,
		wallet: script,
		walletUtxo,
		tokenName: record.tokenName,
		ownerAddress,
		ownerUtxos: await owner.getUtxos(),
		payoutAddress: ownerAddress,
	});
	await signAndSubmit(owner, built.unsignedTx, built.txHash);
	record.sweepTxHash = built.txHash;
	saveState(state);
	await waitForConfirmation(built.txHash, 'sweep');
	record.status = 'retired';
	saveState(state);
	event('swept', { txHash: built.txHash });
	log(`wallet swept and state token burned in ${built.txHash}`);
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
	init,
	mint,
	deny: () => deny(loadState()),
	'allow-batched': () => allowBatched(loadState()),
	'allow-single': () => allowSingle(loadState()),
	report: () => report(loadState()),
	mock: () => mock(loadState()),
	sweep: () => sweep(loadState()),
	all: async () => {
		await mint();
		await deny(loadState());
		await allowBatched(loadState());
		await allowSingle(loadState());
		await report(loadState());
	},
};

const run = command == null ? undefined : commands[command];
if (run == null) {
	console.error(`usage: run.mts <${Object.keys(commands).join(' | ')}>`);
	process.exit(2);
}
run()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		if (error instanceof CosignTransportError) {
			console.error(
				`[smart-wallet-demo] co-sign transport failure (not a denial; nothing submitted): ${error.message}`,
			);
		} else {
			console.error('[smart-wallet-demo] FAILED', error instanceof Error ? error.message : error);
		}
		process.exit(1);
	});
