import { Transaction, resolveTxHash, type IFetcher, type MeshWallet, type UTxO } from '@meshsdk/core';
import type { Network } from '@/generated/prisma/client';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { logger } from '@masumi/payment-core/logger';

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const CONFIRM_POLL_MS = 15_000;
// A carve is a plain value self-payment; one confirmation is enough to safely
// spend its output into the deposit that follows.
const CARVE_CONFIRMATIONS = 1;

/**
 * The floor a lovelace carve has to clear.
 *
 * A carve pays its amount into an output of its own, and the ledger refuses an
 * output holding less than the minimum its size costs — about 0.86 ADA for a
 * plain one at 4310 lovelace per byte. Below that the carve cannot be built at
 * all, so the request fails after the wallet has been claimed and, from a
 * low-balance rule, once every cycle for as long as the rule stays Low. One ADA
 * is the round number above the ledger's floor; a top-up smaller than that
 * moves less than the L1 fee it costs.
 */
export const MIN_CARVE_LOVELACE = 1_000_000n;

export class HydraPreSplitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HydraPreSplitError';
	}
}

function unitAmount(utxo: UTxO, unit: string): bigint {
	const target = unit.toLowerCase();
	let total = 0n;
	for (const asset of utxo.output.amount) {
		if (asset.unit.toLowerCase() === target) total += BigInt(asset.quantity);
	}
	return total;
}

function isPureLovelace(utxo: UTxO): boolean {
	return utxo.output.amount.every((asset) => asset.unit === 'lovelace');
}

/**
 * Whether this UTxO is exactly what a carve of `amount` `unit` would produce.
 *
 * The purity half matters as much as the amount: Hydra commits WHOLE UTxOs, so
 * anything else riding along goes into the head too and only a decommit or a
 * close gets it back. A lovelace carve pays a pure-ADA output; a token carve
 * pays the token and its min-ADA and nothing else, while the change output
 * beside it carries every other asset the wallet held — including an agent's
 * registry NFT.
 */
function isCarveOf(utxo: UTxO, walletAddress: string, unit: string, amount: bigint): boolean {
	if (utxo.output.address !== walletAddress) return false;
	if (unitAmount(utxo, unit) !== amount) return false;
	if (unit === 'lovelace') return isPureLovelace(utxo);
	return utxo.output.amount.every((asset) => asset.unit === 'lovelace' || asset.unit === unit);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Build, sign and submit the L1 self-payment that carves the exact UTxO.
 *
 * The hash is reported BEFORE the submit, not after. A submit that throws has
 * not necessarily failed — a timeout or a dropped response leaves a signed
 * transaction the node may well have accepted — and the caller's decision to
 * hold or hand back the wallet turns on whether a carve might be in flight. The
 * hash is deterministic (blake2b of the signed body), so computing it locally
 * names the same transaction the node will.
 */
async function defaultSubmitCarveTx(
	wallet: MeshWallet,
	walletAddress: string,
	unit: string,
	amount: bigint,
	reportIntendedHash: (txHash: string) => Promise<void>,
): Promise<string> {
	const tx = new Transaction({ initiator: wallet });
	if (unit === 'lovelace') {
		tx.sendLovelace(walletAddress, amount.toString());
	} else {
		tx.sendAssets(walletAddress, [{ unit, quantity: amount.toString() }]);
	}
	const unsigned = await tx.build();
	const signed = await wallet.signTx(unsigned);
	await reportIntendedHash(String(resolveTxHash(signed)).toLowerCase());
	return await wallet.submitTx(signed);
}

/**
 * Pre-split: because Hydra commits WHOLE UTxOs, an exact-amount top-up first
 * carves a dedicated wallet UTxO of exactly `amount` of `unit` via an L1
 * self-payment, waits for it to confirm, and returns it so it can be committed
 * on its own. If confirmation times out or the tx is invalid the funds simply
 * remain in the wallet (no loss) and the caller can retry.
 *
 * `now`/`sleep` are injectable for tests.
 */
export async function carveExactUtxo(params: {
	wallet: MeshWallet;
	blockchainProvider: IFetcher;
	walletAddress: string;
	unit: string;
	amount: bigint;
	network: Network;
	rpcProviderApiKey: string;
	/**
	 * The wallet's current L1 UTxOs, if the caller already has them.
	 *
	 * A carve is an L1 self-payment, so the step that follows it — building and
	 * submitting the deposit — can fail after the money has already been split
	 * off. Retrying then carved *another* dedicated UTxO: a second fee, and a
	 * first one left sitting in the wallet with nothing naming it. Passing the
	 * snapshot lets a retry recognise its own earlier carve and commit that.
	 */
	existingUtxos?: UTxO[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	submitCarveTx?: (
		wallet: MeshWallet,
		walletAddress: string,
		unit: string,
		amount: bigint,
		reportIntendedHash: (txHash: string) => Promise<void>,
	) => Promise<string>;
	/**
	 * Called with the carve transaction's hash as soon as it is known — which is
	 * once it is signed, before it is submitted.
	 *
	 * Two things need it. The wait for confirmation is the longest part of a
	 * top-up, and until the hash is recorded somewhere an operator has nothing to
	 * look up: the funds have left the wallet and no transaction is named
	 * anywhere in the product. And the caller has to know a carve may be in
	 * flight even when this function throws, because until that carve settles its
	 * inputs still read as unspent and an L1 batcher handed the same wallet would
	 * build a second transaction over them.
	 */
	onCarveSubmitted?: (txHash: string) => Promise<void>;
}): Promise<UTxO> {
	if (params.amount <= 0n) throw new HydraPreSplitError('exact top-up amount must be positive');
	if (params.unit === 'lovelace' && params.amount < MIN_CARVE_LOVELACE) {
		throw new HydraPreSplitError(
			`exact top-up amount ${params.amount} is below the ${MIN_CARVE_LOVELACE} lovelace a carved output needs`,
		);
	}

	// Reuse before carving, for ADA only. A pure-lovelace UTxO of exactly this
	// amount is indistinguishable from one this wallet carved a moment ago and
	// could not commit, and committing it means the same thing either way:
	// exactly `amount` goes into the head and nothing else.
	//
	// A token UTxO carries lovelace as well, and how much is not ours to choose:
	// a wallet UTxO holding exactly 750 USDM may sit on 200 ADA, and committing
	// it would lock that ADA in the head until the head closes. A carve pays the
	// ledger minimum, so for a token a second carve is the cheaper mistake.
	const reusable =
		params.unit === 'lovelace'
			? params.existingUtxos?.find((utxo) => isCarveOf(utxo, params.walletAddress, params.unit, params.amount))
			: undefined;
	if (reusable) {
		logger.info('hydra-pre-split: reusing an exact UTxO the wallet already holds', {
			txHash: reusable.input.txHash,
			outputIndex: reusable.input.outputIndex,
			unit: params.unit,
			amount: params.amount.toString(),
		});
		return reusable;
	}

	const submitCarveTx = params.submitCarveTx ?? defaultSubmitCarveTx;
	// Recording the hash must never lose the carve itself, which by then is on
	// its way to the chain either way.
	const reportedHashes = new Set<string>();
	const reportHash = async (hash: string): Promise<void> => {
		if (!params.onCarveSubmitted) return;
		reportedHashes.add(hash);
		await params.onCarveSubmitted(hash).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn(`hydra-pre-split: could not record carve tx ${hash}: ${reason}`);
		});
	};
	let txHash: string;
	try {
		txHash = await submitCarveTx(params.wallet, params.walletAddress, params.unit, params.amount, reportHash);
	} catch (error) {
		throw new HydraPreSplitError(
			`failed to build/submit pre-split carve tx: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	logger.info('hydra-pre-split: carve tx submitted', { txHash, unit: params.unit, amount: params.amount.toString() });
	// Normally already reported, from inside the submit. An injected submitter or
	// a node that answers with a different hash than the one signed is the
	// exception, and the row should name what actually went out.
	if (!reportedHashes.has(txHash.toLowerCase())) await reportHash(txHash);

	const now = params.now ?? Date.now;
	const sleep = params.sleep ?? defaultSleep;
	const deadline = now() + CONFIRM_TIMEOUT_MS;
	for (;;) {
		const result = await lookupConfirmedChainTx({
			network: params.network,
			rpcProviderApiKey: params.rpcProviderApiKey,
			txHash,
			requiredConfirmations: CARVE_CONFIRMATIONS,
		});
		if (result === 'confirmed-valid') break;
		if (result === 'confirmed-invalid') {
			throw new HydraPreSplitError(`pre-split carve tx ${txHash} was invalid on-chain`);
		}
		if (now() >= deadline) {
			throw new HydraPreSplitError(
				`pre-split carve tx ${txHash} did not confirm within the timeout; the funds remain in the wallet for a retry`,
			);
		}
		await sleep(CONFIRM_POLL_MS);
	}

	const outputs = await params.blockchainProvider.fetchUTxOs(txHash);
	const carved = outputs.find((utxo) => isCarveOf(utxo, params.walletAddress, params.unit, params.amount));
	if (!carved) {
		throw new HydraPreSplitError(`carved UTxO of exactly ${params.amount} ${params.unit} not found in tx ${txHash}`);
	}
	return carved;
}
