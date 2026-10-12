/**
 * Local stand-in for Exchain's POST /v1/cosign, for the guarded wallet + Hydra
 * proof. The quorum keys are the test mnemonics in `.state/keys.json`.
 *
 * Real Exchain reads the wallet input from L1 only. This mock also reads the head
 * snapshot, which is the `context.hydraHeadId` extension the service now sends.
 *
 * Run (from the repo root, with the proof env exported):
 *   pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-hydra/mock.mts
 */
import path from 'node:path';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { startMockCosignServer } from '../smart-wallet-demo/cosign-mock';
import type { TxRef } from '../smart-wallet-demo/cosign-policy';
import { ADA, blockfrostKey, loadMnemonics, loadWallets, log, NODE_API, STATE_DIR } from './lib.mjs';

const PORT = Number(process.env.SW_MOCK_PORT ?? 4600);
const ESCROW_ADDRESS = process.env.SW_ESCROW_ADDRESS?.trim();
const API_KEY = process.env.EXCHAIN_COSIGN_API_KEY?.trim();
// Wide enough for the L2 lock window; the policy still bounds it.
const MAX_VALIDITY_SLOTS = 3_600;

type BlockfrostOutput = { output_index: number; address: string; amount: Array<{ unit: string; quantity: string }> };
type SnapshotOutput = { address: string; value: { lovelace: number } };

async function resolveWalletInput(ref: TxRef): Promise<{ address: string; lovelace: bigint }> {
	const l1 = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/txs/${ref.txHash}/utxos`, {
		headers: { project_id: blockfrostKey },
	});
	if (l1.ok) {
		const body = (await l1.json()) as { outputs: BlockfrostOutput[] };
		const output = body.outputs.find((entry) => entry.output_index === ref.outputIndex);
		if (output != null) {
			const lovelace = output.amount.find((asset) => asset.unit === 'lovelace')?.quantity ?? '0';
			return { address: output.address, lovelace: BigInt(lovelace) };
		}
	}
	const snapshot = (await (await fetch(`${NODE_API}/snapshot/utxo`)).json()) as Record<string, SnapshotOutput>;
	const output = snapshot[`${ref.txHash}#${ref.outputIndex}`];
	if (output == null) throw new Error(`utxo_unknown ${ref.txHash}#${ref.outputIndex}`);
	return { address: output.address, lovelace: BigInt(output.value.lovelace) };
}

async function main(): Promise<void> {
	if (ESCROW_ADDRESS == null || API_KEY == null) {
		throw new Error('set SW_ESCROW_ADDRESS and EXCHAIN_COSIGN_API_KEY');
	}
	const mnemonics = loadMnemonics();
	const wallets = await loadWallets();
	const agentVkh = resolvePaymentKeyHash(await wallets.agent.getChangeAddress());
	const server = await startMockCosignServer({
		memberMnemonics: [mnemonics.quorum1, mnemonics.quorum2, mnemonics.quorum3].map((words) => words.join(' ')),
		apiKey: API_KEY,
		threshold: 2,
		maxOutflowLovelace: 40n * ADA,
		maxPerIntentLovelace: 20n * ADA,
		maxValiditySlots: MAX_VALIDITY_SLOTS,
		agentVkhs: [agentVkh],
		escrowAddresses: [ESCROW_ADDRESS],
		resolveWalletInput,
		decisionsFile: path.join(STATE_DIR, 'decisions.jsonl'),
		port: PORT,
	});
	log('mock', `co-signer on ${server.url}, quorum ${server.memberVkhs.join(',')}`);
}

await main();
