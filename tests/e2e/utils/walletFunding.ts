import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/enums';
import type { ApiClient } from './apiClient';
import '../setup/globals';

/**
 * Preflight funding floor for a batched funds-lock: N × per-lock min-UTxO
 * (~5 ADA) + batch overhead (2 ADA fee buffer + 5 ADA splitter). Conservative
 * round numbers — this only needs to catch a grossly underfunded wallet before
 * a long poll, not to predict the exact fee.
 */
const PER_LOCK_LOVELACE_ESTIMATE = 5_000_000n;
const BATCH_TX_OVERHEAD_LOVELACE = 7_000_000n;

function blockfrostBaseUrl(network: Network): string {
	return network === Network.Mainnet
		? 'https://cardano-mainnet.blockfrost.io/api/v0'
		: 'https://cardano-preprod.blockfrost.io/api/v0';
}

/** Total lovelace at an address per Blockfrost. Returns 0 for an unused (404) address. */
async function getAddressLovelace(address: string, projectId: string, network: Network): Promise<bigint> {
	const res = await fetch(`${blockfrostBaseUrl(network)}/addresses/${address}`, {
		headers: { project_id: projectId },
	});
	if (res.status === 404) return 0n;
	if (!res.ok) {
		throw new Error(`Blockfrost address lookup failed (${res.status}) for ${address}`);
	}
	const body = (await res.json()) as { amount?: Array<{ unit: string; quantity: string }> };
	const lovelace = body.amount?.find((a) => a.unit === 'lovelace')?.quantity ?? '0';
	return BigInt(lovelace);
}

/**
 * Fail fast, with an actionable message, when no single purchasing wallet can
 * fund `concurrentLocks` locks at once.
 *
 * Concurrency raises this bar. Flows that lock one after another only ever need
 * one lock's worth in the wallet at a time; flows that lock together are packed
 * into one transaction by the batch builder, which fills the FIRST eligible
 * wallet before it reaches for a second. So the requirement is one wallet at or
 * above the floor, not the sum across wallets.
 *
 * Without this check a thin wallet does not merely slow the suite down: the
 * batch builder parks the requests it cannot fund in WaitingForManualAction
 * with InsufficientFunds, which never retries.
 */
export async function assertPurchasingWalletFunded(options: {
	network: Network;
	paymentSourceType: PaymentSourceType;
	concurrentLocks: number;
	apiClient?: ApiClient;
}): Promise<void> {
	const { network, paymentSourceType, concurrentLocks } = options;
	const client = options.apiClient ?? global.testApiClient;
	const requiredLovelace = BigInt(concurrentLocks) * PER_LOCK_LOVELACE_ESTIMATE + BATCH_TX_OVERHEAD_LOVELACE;

	const { ExtendedPaymentSources } = await client.queryPaymentSources({ take: 100 });
	const source = ExtendedPaymentSources.find((s) => s.paymentSourceType === paymentSourceType && s.network === network);
	if (!source) {
		throw new Error(`Preflight: no ${paymentSourceType} payment source found on ${network} to check funding.`);
	}

	const projectId = source.PaymentSourceConfig.rpcProviderApiKey;
	const { Wallets: purchasingWallets } = await client.queryWallets({
		paymentSourceId: source.id,
		walletType: HotWalletType.Purchasing,
		take: 100,
	});

	const observed: string[] = [];
	for (const wallet of purchasingWallets) {
		const lovelace = await getAddressLovelace(wallet.walletAddress, projectId, network);
		observed.push(`${wallet.walletAddress} = ${(Number(lovelace) / 1e6).toFixed(2)} ADA`);
		if (lovelace >= requiredLovelace) {
			return;
		}
	}

	throw new Error(
		`Preflight: ${paymentSourceType} purchasing wallet underfunded for a ${concurrentLocks}-lock batch. ` +
			`Need ≥ ${(Number(requiredLovelace) / 1e6).toFixed(2)} ADA in a SINGLE purchasing wallet. ` +
			`Observed: ${observed.join('; ') || '(no purchasing wallets)'}. ` +
			`Fund one of these addresses via the Cardano preprod faucet ` +
			`(https://docs.cardano.org/cardano-testnet/tools/faucet/) — this is the seeded purchasing hot wallet, ` +
			`not the buyer fixture vkey.`,
	);
}
