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
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	submitCarveTx?: (wallet: MeshWallet, walletAddress: string, unit: string, amount: bigint) => Promise<string>;
}): Promise<UTxO> {
	if (params.amount <= 0n) throw new HydraPreSplitError('exact top-up amount must be positive');

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
	const carved = outputs.find(
		(utxo) =>
			utxo.output.address === params.walletAddress &&
			unitAmount(utxo, params.unit) === params.amount &&
			(params.unit !== 'lovelace' || isPureLovelace(utxo)),
	);
	if (!carved) {
		throw new HydraPreSplitError(`carved UTxO of exactly ${params.amount} ${params.unit} not found in tx ${txHash}`);
	}
	return carved;
}
