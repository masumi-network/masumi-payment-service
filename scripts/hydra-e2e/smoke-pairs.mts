/**
 * Ten escrows between the two nodes, as fast as they will take them.
 *
 * Drives the product through its own API and nothing else: the seller mints a
 * payment request, the buyer purchases against it, ten times, with no wait
 * between them. Back to back on purpose — a head locks with one participating
 * wallet that builds one transaction at a time, so submitting them together is
 * what actually exercises the queue rather than ten isolated happy paths.
 *
 *   AGENT_IDENTIFIER=<id> pnpm exec tsx scripts/hydra-e2e/smoke-pairs.mts
 *   AGENT_IDENTIFIER=<id> PAIRS=3 pnpm exec tsx scripts/hydra-e2e/smoke-pairs.mts
 *
 * Test support only.
 */

const SELLER = { label: 'B', base: 'http://127.0.0.1:3002', key: 'node-b-admin-key-0123456789abcdef' };
const BUYER = { label: 'A', base: 'http://127.0.0.1:3001', key: 'node-a-admin-key-0123456789abcdef' };
const NETWORK = 'Preprod';
const PAIRS = Number(process.env.PAIRS ?? '10');

type Side = typeof SELLER;

function log(message: string): void {
	console.log(`[smoke] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

async function api<T>(side: Side, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${side.base}/api/v1${path}`, {
		method,
		headers: { token: side.key, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: { status?: string; data?: T; error?: { message?: string } };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		throw new Error(`${method} ${path} on ${side.label}: ${response.status} ${text.slice(0, 200)}`);
	}
	if (parsed.status !== 'success' || parsed.data === undefined) {
		throw new Error(`${method} ${path} on ${side.label}: ${parsed.error?.message ?? text.slice(0, 200)}`);
	}
	return parsed.data;
}

/**
 * The seller's V2 wallet, which owns the agent and receives payment.
 *
 * SELLER_VKEY short-circuits the lookup. The list endpoints report a payment
 * source's admin and fee wallets but not its hot wallets, so discovery only
 * works where a node exposes them; being able to name it keeps the script
 * usable against one that does not.
 */
async function sellerWalletVkey(): Promise<string> {
	const supplied = process.env.SELLER_VKEY?.trim();
	if (supplied) {
		log(`seller wallet supplied: ${supplied.slice(0, 16)}…`);
		return supplied;
	}
	const sources = await api<{
		PaymentSources: Array<{
			paymentSourceType: string;
			network: string;
			SellingWallets?: Array<{ walletVkey: string }>;
		}>;
	}>(SELLER, 'GET', '/payment-source/?take=10');
	const source = sources.PaymentSources.find(
		(entry) => entry.paymentSourceType === 'Web3CardanoV2' && entry.network === NETWORK,
	);
	const vkey = source?.SellingWallets?.[0]?.walletVkey;
	if (!vkey) throw new Error('no V2 selling wallet on the seller node');
	return vkey;
}

/**
 * The agent the buyer purchases from, checked against the seller's API.
 *
 * Taken as input rather than discovered: the listing endpoints answer about
 * on-chain assets and wallet lookups rather than "which agents has this node
 * registered", so picking one out of them would be guesswork. What matters is
 * that it is verified before ten escrows are built on it.
 */
async function resolveAgent(): Promise<string> {
	const identifier = process.env.AGENT_IDENTIFIER?.trim();
	if (!identifier) {
		throw new Error("set AGENT_IDENTIFIER to the seller's registered agent");
	}
	// Ask the seller node whether it is real and registered, so a typo fails
	// here rather than ten payment requests later.
	await api(SELLER, 'GET', `/registry/agent-identifier?network=${NETWORK}&agentIdentifier=${identifier}`);
	log(`agent verified on ${SELLER.label}: ${identifier.slice(0, 24)}…`);
	return identifier;
}

/** Deadlines far enough out that none of them is what fails. */
function deadlines(): Record<string, string> {
	const now = Date.now();
	const minutes = (count: number) => String(now + count * 60_000);
	return {
		payByTime: minutes(20),
		submitResultTime: minutes(40),
		unlockTime: minutes(60),
		externalDisputeUnlockTime: minutes(80),
	};
}

type Pair = { index: number; blockchainIdentifier: string; purchaseId: string };

async function runPair(index: number, agentIdentifier: string, sellerVkey: string): Promise<Pair> {
	const identifierFromPurchaser = `smoke${String(index).padStart(2, '0')}${Date.now().toString(36)}`.slice(0, 26);
	const inputHash = `smoke-input-${index}-${Date.now()}`;

	const payment = await api<{
		blockchainIdentifier: string;
		payByTime: string;
		submitResultTime: string;
		unlockTime: string;
		externalDisputeUnlockTime: string;
	}>(SELLER, 'POST', '/payment/', {
		network: NETWORK,
		agentIdentifier,
		inputHash,
		identifierFromPurchaser,
		paymentSourceType: 'Web3CardanoV2',
		...deadlines(),
	});

	// The purchase must echo the seller's own deadlines, not recompute them:
	// they are signed into the identifier the seller minted.
	const purchase = await api<{ id: string }>(BUYER, 'POST', '/purchase/', {
		network: NETWORK,
		blockchainIdentifier: payment.blockchainIdentifier,
		agentIdentifier,
		sellerVkey,
		inputHash,
		identifierFromPurchaser,
		paymentSourceType: 'Web3CardanoV2',
		payByTime: payment.payByTime,
		submitResultTime: payment.submitResultTime,
		unlockTime: payment.unlockTime,
		externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
	});

	return { index, blockchainIdentifier: payment.blockchainIdentifier, purchaseId: purchase.id };
}

async function main(): Promise<void> {
	const agentIdentifier = await resolveAgent();
	const sellerVkey = await sellerWalletVkey();

	log(`creating ${PAIRS} payment/purchase pairs, no wait between them…`);
	const started = Date.now();
	// All at once. Serialising them here would measure this script rather than
	// the service, and contention is the thing worth seeing.
	const settled = await Promise.allSettled(
		Array.from({ length: PAIRS }, (_, index) => runPair(index + 1, agentIdentifier, sellerVkey)),
	);
	const elapsedMs = Date.now() - started;

	const created = settled.filter((result) => result.status === 'fulfilled').length;
	log(`${created}/${PAIRS} pairs created in ${(elapsedMs / 1000).toFixed(1)}s`);
	for (const [index, result] of settled.entries()) {
		if (result.status === 'rejected') {
			log(`  pair ${index + 1} failed: ${String(result.reason).slice(0, 160)}`);
		}
	}
	if (created === 0) throw new Error('no pairs were created');

	log("locking is the orchestrator's job from here — watch the purchases list for L2 vs L1.");
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
