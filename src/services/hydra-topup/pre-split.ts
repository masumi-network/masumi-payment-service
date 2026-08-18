import { Transaction, type IFetcher, type MeshWallet, type UTxO } from '@meshsdk/core';
import type { Network } from '@/generated/prisma/client';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { logger } from '@masumi/payment-core/logger';

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const CONFIRM_POLL_MS = 15_000;
// A carve is a plain value self-payment; one confirmation is enough to safely
// spend its output into the deposit that follows.
const CARVE_CONFIRMATIONS = 1;

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

/** Build, sign and submit the L1 self-payment that carves the exact UTxO. */
async function defaultSubmitCarveTx(
	wallet: MeshWallet,
	walletAddress: string,
	unit: string,
	amount: bigint,
): Promise<string> {
	const tx = new Transaction({ initiator: wallet });
	if (unit === 'lovelace') {
		tx.sendLovelace(walletAddress, amount.toString());
	} else {
		tx.sendAssets(walletAddress, [{ unit, quantity: amount.toString() }]);
	}
	const unsigned = await tx.build();
	const signed = await wallet.signTx(unsigned);
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
	submitCarveTx?: (wallet: MeshWallet, walletAddress: string, unit: string, amount: bigint) => Promise<string>;
	/**
	 * Called with the carve transaction's hash the moment it is submitted.
	 *
	 * The wait for it to confirm is the longest part of a top-up, and until the
	 * hash is recorded somewhere an operator has nothing to look up: the funds
	 * have left the wallet and no transaction is named anywhere in the product.
	 */
	onCarveSubmitted?: (txHash: string) => Promise<void>;
}): Promise<UTxO> {
	if (params.amount <= 0n) throw new HydraPreSplitError('exact top-up amount must be positive');

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
	let txHash: string;
	try {
		txHash = await submitCarveTx(params.wallet, params.walletAddress, params.unit, params.amount);
	} catch (error) {
		throw new HydraPreSplitError(
			`failed to build/submit pre-split carve tx: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	logger.info('hydra-pre-split: carve tx submitted', { txHash, unit: params.unit, amount: params.amount.toString() });
	if (params.onCarveSubmitted) {
		// Recording it must never lose the carve itself, which is already on chain.
		await params.onCarveSubmitted(txHash).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn(`hydra-pre-split: could not record carve tx ${txHash}: ${reason}`);
		});
	}

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
