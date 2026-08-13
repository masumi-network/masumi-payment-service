import 'dotenv/config';
import { MeshTxBuilder, resolvePaymentKeyHash } from '@meshsdk/core';
import {
	Action,
	AGENT_WALLET_INDEX,
	applyAgentSpend,
	assetsMinus,
	blockchainProvider,
	COSIGNER_WALLET_INDEXES,
	fetchWalletUtxo,
	firstWalletAddress,
	loadSmartWalletScript,
	loadWallet,
	lovelaceAsset,
	lovelaceOf,
	network,
	outflowOf,
	pickCollateral,
	readAddress,
	readWalletDatum,
	RECIPIENT_WALLET_INDEX,
	resolveValidity,
	syncCostModelsFromChain,
	walletDatumData,
} from './example-helpers.mjs';

// Differential fuzz against the LIVE compiled validator on preprod.
//
// Each round draws a random payout and a random counter perturbation, asks the
// off-chain mirror (`applyAgentSpend`) whether the spend should pass, then
// builds the transaction and lets `.complete()` evaluate the real script on
// the real UTxO. The two verdicts must agree — a disagreement means the mirror
// and the validator have drifted, which is exactly the bug class that bites in
// production. Nothing is ever submitted.
//
// The aiken-side property tests cover the arithmetic; this covers the whole
// validator, CBOR encoding included, because a full-Transaction property test
// trips a silent aiken v1.1.23 failure (see property_test.ak).

const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 12);
const seedArg = Number(process.env.FUZZ_SEED ?? Date.now() % 2147483647);

// Deterministic PRNG so a failing round is reproducible with FUZZ_SEED.
let prngState = seedArg;
function random() {
	prngState = (prngState * 48271) % 2147483647;
	return prngState / 2147483647;
}
function randomInt(min, max) {
	return min + Math.floor(random() * (max - min + 1));
}

console.log(`E2E differential fuzz: ${ROUNDS} rounds, seed ${seedArg}\n`);

await syncCostModelsFromChain();

const agent = loadWallet(AGENT_WALLET_INDEX);
const agentAddress = await firstWalletAddress(agent);
const agentKeyHash = resolvePaymentKeyHash(agentAddress);
const recipient = readAddress(RECIPIENT_WALLET_INDEX);

const wallet = loadSmartWalletScript();
const utxo = await fetchWalletUtxo(blockchainProvider, wallet);
const datum = readWalletDatum(utxo);
const agentUtxos = await agent.getUtxos();
const collateral = pickCollateral(agentUtxos);
const cosignerHashes = COSIGNER_WALLET_INDEXES.map((index) =>
	resolvePaymentKeyHash(readAddress(index)),
).filter((hash) => wallet.quorum.includes(hash));

const balance = lovelaceOf(utxo.output.amount);
const limit = datum.limit.get('')?.get('') ?? 0n;
console.log(`wallet balance ${balance}, lovelace limit ${limit}, floor ${datum.minBalanceLovelace}\n`);

let disagreements = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
	const validity = resolveValidity();
	// Payouts across the interesting boundaries: within budget, at it, over it,
	// and over the min-balance floor.
	const payout = BigInt(randomInt(0, Number(limit) + 8_000_000));
	// Sometimes lie about the counter to probe the datum-equality check.
	const lie = random() < 0.3 ? BigInt(randomInt(-3_000_000, 3_000_000)) : 0n;

	let mirrorVerdict = true;
	let mirrorReason = '';
	let nextDatum;
	try {
		const remaining = assetsMinus(utxo.output.amount, lovelaceAsset(payout));
		if (lovelaceOf(remaining) < datum.minBalanceLovelace) {
			throw new Error('below min balance');
		}
		nextDatum = applyAgentSpend(datum, outflowOf(utxo.output.amount, remaining), validity);
		if (lie !== 0n) {
			const honest = nextDatum.spentInPeriod.get('').get('');
			const forged = honest + lie;
			if (forged < 0n) throw new Error('forged counter below zero, unbuildable');
			nextDatum = { ...nextDatum, spentInPeriod: new Map([['', new Map([['', forged]])]]) };
			mirrorVerdict = false;
			mirrorReason = `counter forged by ${lie}`;
		}
	} catch (error) {
		mirrorVerdict = false;
		mirrorReason = error.message;
	}

	let chainVerdict;
	let chainDetail = '';
	if (nextDatum === undefined) {
		// The mirror refused before producing a datum; there is nothing coherent
		// to put on-chain, and that refusal is itself the correct verdict.
		chainVerdict = false;
		chainDetail = 'not buildable';
	} else {
		try {
			const remaining = assetsMinus(utxo.output.amount, lovelaceAsset(payout));
			const tx = new MeshTxBuilder({ fetcher: blockchainProvider, submitter: blockchainProvider, evaluator: blockchainProvider, verbose: false })
				.spendingPlutusScriptV3()
				.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
				.txInScript(wallet.script.code)
				.txInRedeemerValue({ alternative: Action.AgentSpend, fields: [] })
				.txInInlineDatumPresent()
				.txOut(wallet.address, remaining)
				.txOutInlineDatumValue(walletDatumData(nextDatum))
				.txOut(recipient, lovelaceAsset(payout))
				.txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
				.setTotalCollateral('5000000')
				.requiredSignerHash(agentKeyHash)
				.requiredSignerHash(cosignerHashes[0])
				.requiredSignerHash(cosignerHashes[1])
				.changeAddress(agentAddress)
				.selectUtxosFrom(agentUtxos)
				.invalidBefore(validity.invalidBefore)
				.invalidHereafter(validity.invalidAfter)
				.setNetwork(network);
			await tx.complete();
			chainVerdict = true;
		} catch (error) {
			chainVerdict = false;
			chainDetail = String(error?.message ?? error).slice(0, 90);
		}
	}

	const agree = mirrorVerdict === chainVerdict;
	if (!agree) disagreements += 1;
	console.log(
		`round ${String(round).padStart(2)}: payout ${String(payout).padStart(9)}${lie !== 0n ? ` lie ${lie}` : ''}` +
			` | mirror ${mirrorVerdict ? 'accept' : `reject (${mirrorReason})`}` +
			` | chain ${chainVerdict ? 'accept' : 'reject'}` +
			` | ${agree ? 'AGREE' : `DISAGREE ${chainDetail}`}`,
	);
}

console.log(`\n${disagreements === 0 ? 'Mirror and validator agree on every round.' : `${disagreements} DISAGREEMENT(S) — mirror and validator have drifted`}`);
process.exit(disagreements === 0 ? 0 : 1);
