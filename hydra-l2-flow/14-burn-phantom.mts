/**
 * 14-burn-phantom — neutralize the Hydra 2.2.0 deposit re-apply phantom before Close.
 *
 * Each node restart re-applies the head's deposit to the L2 ledger (upstream
 * idempotency bug, unfixed as of 2.2.0/master 2026-07-06), inflating the L2
 * UTxO total above the L1 head output's real capacity
 * (headLovelace − storedHeadAdaOverhead). Close then fails H65
 * (ChangedHeadAdaOverhead) because the off-chain builder re-computes the
 * overhead from the inflated snapshot.
 *
 * Fix: in-head tx FEES destroy L2 value (they are not redistributed). Burn
 * exactly the phantom as the fee of one L2 tx spending funds-address UTxOs,
 * bringing the L2 total back to the target so Close passes H65.
 *
 * Run (repo root): HYDRA_FLOW_NETWORK=preprod pnpm exec tsx hydra-l2-flow/14-burn-phantom.mts
 * Env:
 *   TARGET_L2_TOTAL  — expected true L2 total in lovelace
 *                      (headLovelace − storedHeadAdaOverhead). Required.
 *   MIN_CHANGE       — min lovelace kept as change (default 2_000_000).
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshTxBuilder } from '@meshsdk/core';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraProvider } from '@/lib/hydra/hydra/provider';

const NETWORK = process.env.HYDRA_FLOW_NETWORK ?? 'devnet';
const TARGET = BigInt(process.env.TARGET_L2_TOTAL ?? '0');
const MIN_CHANGE = BigInt(process.env.MIN_CHANGE ?? '2000000');
const FUNDS_SK = NETWORK === 'preprod' ? '/keys/purchasing-cardano.sk' : '/devnet/credentials/alice-funds.sk';

function log(m: string) {
	console.log(`[burn-phantom] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function derivePurchasingAddr(): string {
	const preprodDir = join(process.cwd(), 'hydra-l2-flow', 'preprod');
	return execSync(
		`docker run --rm -v ${JSON.stringify(preprodDir)}:/keys --entrypoint cardano-cli ghcr.io/intersectmbo/cardano-node:10.6.2 address build --payment-verification-key-file /keys/purchasing-cardano.vk --testnet-magic 1`,
		{ encoding: 'utf-8' },
	).trim();
}

function signWithCardanoCli(cborHex: string, credKeyPath: string): string {
	const tmpIn = join(tmpdir(), `burn-draft-${Date.now()}.tx`);
	writeFileSync(tmpIn, JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex }));
	try {
		if (NETWORK === 'preprod') {
			const preprodDir = join(process.cwd(), 'hydra-l2-flow', 'preprod');
			const signedJson = execSync(
				`docker run --rm -i -v ${JSON.stringify(preprodDir)}:/keys --entrypoint sh ghcr.io/intersectmbo/cardano-node:10.6.2 -c ` +
					JSON.stringify(`cat > /tmp/d.tx && cardano-cli conway transaction sign --tx-file /tmp/d.tx --signing-key-file ${credKeyPath} --testnet-magic 1 --out-file /tmp/s.tx && cat /tmp/s.tx`),
				{ input: readFileSync(tmpIn, 'utf-8'), encoding: 'utf-8' },
			);
			return (JSON.parse(signedJson) as { cborHex: string }).cborHex;
		}
		throw new Error('devnet signing not wired for burn (preprod-only script)');
	} finally {
		try {
			unlinkSync(tmpIn);
		} catch {
			/* ignore */
		}
	}
}

async function main() {
	if (TARGET <= 0n) throw new Error('TARGET_L2_TOTAL env required (headLovelace − storedHeadAdaOverhead)');

	const node = new HydraNode({ httpUrl: 'http://127.0.0.1:4001' });
	node.connect();
	await new Promise((r) => setTimeout(r, 1500));
	const provider = new HydraProvider({ node });
	await new Promise((r) => setTimeout(r, 600));

	const utxos = await node.snapshotUTxO();
	const total = utxos.reduce((s, u) => s + BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'), 0n);
	const phantom = total - TARGET;
	log(`L2 total=${total} target=${TARGET} phantom=${phantom}`);

	if (phantom === 0n) {
		log('no phantom — nothing to burn, Close is already consistent');
		process.exit(0);
	}
	if (phantom < 0n) throw new Error(`L2 total ${total} BELOW target ${TARGET} — burning cannot fix this, aborting`);

	// Select funds-address pure-ADA key-witness UTxOs (largest first) until they
	// cover phantom + MIN_CHANGE. Abort loudly on shortfall — never burn blind.
	const fundsAddr = derivePurchasingAddr();
	const candidates = utxos
		.filter(
			(u) =>
				!u.output.plutusData &&
				u.output.address === fundsAddr &&
				u.output.amount.length === 1 &&
				u.output.amount[0].unit === 'lovelace',
		)
		.sort((a, b) => Number(BigInt(b.output.amount[0].quantity) - BigInt(a.output.amount[0].quantity)));
	const available = candidates.reduce((s, u) => s + BigInt(u.output.amount[0].quantity), 0n);
	log(`funds-addr candidates: ${candidates.length} UTxO(s), ${available} lovelace available`);
	if (available < phantom + MIN_CHANGE) {
		throw new Error(
			`funds-addr balance ${available} < phantom ${phantom} + minChange ${MIN_CHANGE} — ` +
				'need buyer/seller-signed burns (contingency), refusing to burn blind',
		);
	}
	const selected: typeof candidates = [];
	let sum = 0n;
	for (const u of candidates) {
		selected.push(u);
		sum += BigInt(u.output.amount[0].quantity);
		if (sum >= phantom + MIN_CHANGE) break;
	}
	log(`selected ${selected.length} input(s) totalling ${sum}; fee=${phantom} change=${sum - phantom}`);

	// isHydra zeroes fee params; the explicit setFee(phantom) makes the head
	// ledger destroy exactly the phantom. changeAddress emits the single change
	// output (sum − phantom) back to the funds address.
	const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, isHydra: true });
	for (const u of selected) {
		tx.txIn(u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address);
	}
	await tx.setFee(phantom.toString()).changeAddress(fundsAddr).complete();

	log('signing with funds key (in-head UTxO owner)…');
	const signed = signWithCardanoCli(tx.txHex, FUNDS_SK);
	const txHash = await provider.submitTx(signed);
	log(`submitted L2 burn tx: ${txHash}`);

	const confirmed = await Promise.race([
		node.awaitTx(txHash, 500).then(() => true),
		new Promise<boolean>((r) => setTimeout(() => r(false), 20000)),
	]);
	log(`confirmed in snapshot: ${confirmed}`);

	// Ground truth: the L2 total must now equal the target exactly.
	const after = await node.snapshotUTxO();
	const newTotal = after.reduce((s, u) => s + BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'), 0n);
	log(`post-burn L2 total=${newTotal} (target ${TARGET})`);
	if (newTotal !== TARGET) {
		throw new Error(`post-burn total ${newTotal} != target ${TARGET} — do NOT Close yet`);
	}
	log(`=== PHANTOM BURNED: ${phantom} lovelace destroyed as L2 fee (tx ${txHash}) — Close is now H65-consistent ===`);
	process.exit(0);
}

main().catch((e) => {
	console.error('[burn-phantom] FATAL', e);
	process.exit(1);
});
