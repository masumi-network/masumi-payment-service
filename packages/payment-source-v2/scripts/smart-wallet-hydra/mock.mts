/**
 * Local stand-in for Exchain's POST /v1/cosign, for the guarded wallet + Hydra
 * proof. The quorum keys are the test mnemonics in `.state/keys.json`.
 *
 * An L1 wallet input is read from chain. An in-head one comes from the signed
 * snapshot in `context.hydraSnapshot`, checked the way Exchain should:
 * - the head's parties are read from its open state datum on L1, and every one
 *   must be in `SW_TRUSTED_HYDRA_PARTIES` (anyone can mint a token named
 *   `HydraHeadV2`, so the L1 read alone proves nothing);
 * - the wallet output is found by the wallet's state token (from
 *   `.state/prove.json`), because snapshot signatures do not cover refs;
 * - a head's snapshot number may not go backwards.
 *
 * Run (from the repo root, with the proof env exported):
 *   pnpm exec tsx packages/payment-source-v2/scripts/smart-wallet-hydra/mock.mts
 */
import path from 'node:path';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { Constr, Data } from 'lucid-cardano';
import type { CosignContext } from '../../src/smart-wallet/cosign-client';
import { verifyHydraSnapshotProof } from '../../src/smart-wallet/hydra-snapshot/snapshot-proof';
import { startMockCosignServer } from '../smart-wallet-demo/cosign-mock';
import type { TxRef, VerifyInput } from '../smart-wallet-demo/cosign-policy';
import { ADA, blockfrostKey, loadMnemonics, loadWallets, log, readState, STATE_DIR } from './lib.mjs';

const PORT = Number(process.env.SW_MOCK_PORT ?? 4600);
const ESCROW_ADDRESS = process.env.SW_ESCROW_ADDRESS?.trim();
const API_KEY = process.env.EXCHAIN_COSIGN_API_KEY?.trim();
// Wide enough for the L2 lock window; the policy still bounds it.
const MAX_VALIDITY_SLOTS = 3_600;
const BLOCKFROST = 'https://cardano-preprod.blockfrost.io/api/v0';
/** Asset name of the head's state token (hydra-node 2.4.1, `HydraHeadV2`). */
const HEAD_STATE_TOKEN = Buffer.from('HydraHeadV2').toString('hex');
const TRUSTED_PARTIES = new Set(
	(process.env.SW_TRUSTED_HYDRA_PARTIES ?? '')
		.split(',')
		.map((key) => key.trim().toLowerCase())
		.filter((key) => key !== ''),
);
/** Highest snapshot number accepted per head: an older one could show an older wallet. */
const newestSnapshot = new Map<string, number>();

type BlockfrostOutput = { output_index: number; address: string; amount: Array<{ unit: string; quantity: string }> };

async function blockfrost<T>(route: string): Promise<T> {
	const response = await fetch(`${BLOCKFROST}${route}`, { headers: { project_id: blockfrostKey } });
	if (!response.ok) throw new Error(`blockfrost ${route}: ${response.status}`);
	return (await response.json()) as T;
}

/** Fields of constructor 0; any other index is not an open head. */
const openFields = (data: Data | undefined): Data[] => {
	if (!(data instanceof Constr) || data.index !== 0) throw new Error('head datum is not an open head');
	return data.fields;
};

/** `State = Constr 0 [OpenDatum]`, `OpenDatum = Constr 0 [seed, headId, parties, ...]` (hydra 2.4.1 HeadState.hs). */
async function headPartyKeysFromL1(headId: string): Promise<string[]> {
	const unit = `${headId}${HEAD_STATE_TOKEN}`;
	const [holder] = await blockfrost<Array<{ address: string }>>(`/assets/${unit}/addresses`);
	if (holder == null) throw new Error('head state token not found on L1');
	const [utxo] = await blockfrost<Array<{ inline_datum: string | null }>>(`/addresses/${holder.address}/utxos/${unit}`);
	if (utxo?.inline_datum == null) throw new Error('head state output has no inline datum');
	const open = openFields(openFields(Data.from(utxo.inline_datum))[0]);
	// Lucid decodes Plutus bytes as hex strings and lists as arrays.
	const [, datumHeadId, parties] = open;
	if (datumHeadId !== headId) throw new Error('head datum names another head');
	if (!Array.isArray(parties)) throw new Error('head datum has no party list');
	const keys = parties.map((party) => {
		if (typeof party !== 'string') throw new Error('party key is not bytes');
		return party;
	});
	if (keys.length === 0 || !keys.every((key) => TRUSTED_PARTIES.has(key))) {
		throw new Error('head has a party outside SW_TRUSTED_HYDRA_PARTIES');
	}
	return keys;
}

async function resolveWalletInput(ref: TxRef, context: CosignContext): Promise<VerifyInput['walletInput']> {
	const walletUtxoRef = `${ref.txHash}#${ref.outputIndex}`;
	// The node sends both fields together; one alone must not fall back to the L1 path.
	if ((context.hydraHeadId == null) !== (context.hydraSnapshot == null)) {
		throw new Error('hydraHeadId and hydraSnapshot must be sent together');
	}
	if (context.hydraHeadId != null) {
		const proof = context.hydraSnapshot;
		if (proof == null) throw new Error('in-head spend without a snapshot proof');
		const wallet = readState<{ wallet?: { address: string; policyId: string; stateTokenName: string } }>(
			'prove',
		)?.wallet;
		if (wallet == null) throw new Error('no guarded wallet in .state/prove.json');
		if (proof.number < (newestSnapshot.get(context.hydraHeadId) ?? 0))
			throw new Error('snapshot is older than one already seen');
		const stateTokenUnit = `${wallet.policyId}${wallet.stateTokenName}`;
		const output = verifyHydraSnapshotProof({
			proof,
			headId: context.hydraHeadId,
			partyKeys: await headPartyKeysFromL1(context.hydraHeadId),
			stateTokenUnit,
			walletUtxoRef,
		});
		if (output.address !== wallet.address) throw new Error('state token output is not at the wallet address');
		// Re-check after the L1 read: another request may have moved the mark meanwhile.
		const newest = newestSnapshot.get(context.hydraHeadId) ?? 0;
		if (proof.number < newest) throw new Error('snapshot is older than one already seen');
		newestSnapshot.set(context.hydraHeadId, Math.max(newest, proof.number));
		const lovelace = output.value.lovelace;
		if (typeof lovelace !== 'string') throw new Error('wallet output has no lovelace');
		log('mock', `in-head wallet input ${walletUtxoRef} proven by snapshot ${proof.number}`);
		return { address: output.address, lovelace: BigInt(lovelace), stateTokenUnit };
	}
	const body = await blockfrost<{ outputs: BlockfrostOutput[] }>(`/txs/${ref.txHash}/utxos`);
	const output = body.outputs.find((entry) => entry.output_index === ref.outputIndex);
	if (output == null) throw new Error(`utxo_unknown ${walletUtxoRef}`);
	const lovelace = output.amount.find((asset) => asset.unit === 'lovelace')?.quantity ?? '0';
	return { address: output.address, lovelace: BigInt(lovelace) };
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
