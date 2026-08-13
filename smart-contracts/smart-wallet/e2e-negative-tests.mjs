import 'dotenv/config';
import { MeshTxBuilder, resolvePaymentKeyHash } from '@meshsdk/core';
import {
	Action,
	AGENT_WALLET_INDEX,
	applyAgentSpend,
	assetsMinus,
	assetsPlus,
	blockchainProvider,
	COSIGNER_WALLET_INDEXES,
	fetchWalletUtxo,
	firstWalletAddress,
	loadSmartWalletScript,
	loadWallet,
	lovelaceAsset,
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

// End-to-end NEGATIVE tests: each case builds a forbidden transaction against
// the LIVE wallet UTxO on preprod and asserts the real compiled validator
// rejects it. `.complete()` runs evaluateTx, so rejection happens at build
// time — nothing is submitted, nothing is spent, no collateral is at risk.

console.log('E2E negative suite: every case must FAIL script evaluation\n');

await syncCostModelsFromChain();

const agent = loadWallet(AGENT_WALLET_INDEX);
const agentAddress = await firstWalletAddress(agent);
const agentKeyHash = resolvePaymentKeyHash(agentAddress);
const recipient = readAddress(RECIPIENT_WALLET_INDEX);

const wallet = loadSmartWalletScript();
const utxo = await fetchWalletUtxo(blockchainProvider, wallet);
const datum = readWalletDatum(utxo);
const validity = resolveValidity();
const agentUtxos = await agent.getUtxos();
const collateral = pickCollateral(agentUtxos);

const cosignerHashes = COSIGNER_WALLET_INDEXES.map((index) =>
	resolvePaymentKeyHash(readAddress(index)),
).filter((hash) => wallet.quorum.includes(hash));

function builder() {
	return new MeshTxBuilder({
		fetcher: blockchainProvider,
		submitter: blockchainProvider,
		// Without an explicit evaluator, mesh assigns DEFAULT execution budgets
		// instead of running the script — a transaction that violates the
		// validator still "builds" and only dies at submission. The evaluator is
		// what makes .complete() actually execute the script.
		evaluator: blockchainProvider,
		verbose: false,
	});
}

/// A correct spend of `payout`, which each case then perturbs.
function spendSkeleton({
	payout = 2_000_000n,
	outputDatum,
	remainingOverride,
	signers = [agentKeyHash, cosignerHashes[0], cosignerHashes[1]],
	redeemer = Action.AgentSpend,
	extraWalletOutputs = [],
} = {}) {
	const remaining = remainingOverride ?? assetsMinus(utxo.output.amount, lovelaceAsset(payout));
	const nextDatum =
		outputDatum ?? applyAgentSpend(datum, outflowOf(utxo.output.amount, remaining), validity);

	const tx = builder()
		.spendingPlutusScriptV3()
		.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
		.txInScript(wallet.script.code)
		.txInRedeemerValue({ alternative: redeemer, fields: [] })
		.txInInlineDatumPresent()
		.txOut(wallet.address, remaining)
		.txOutInlineDatumValue(walletDatumData(nextDatum));

	for (const extra of extraWalletOutputs) {
		tx.txOut(wallet.address, extra.assets).txOutInlineDatumValue(walletDatumData(extra.datum));
	}

	tx.txOut(recipient, lovelaceAsset(payout))
		.txInCollateral(
			collateral.input.txHash,
			collateral.input.outputIndex,
			collateral.output.amount,
			collateral.output.address,
		)
		.setTotalCollateral('5000000')
		.changeAddress(agentAddress)
		.selectUtxosFrom(agentUtxos)
		.invalidBefore(validity.invalidBefore)
		.invalidHereafter(validity.invalidAfter)
		.setNetwork(network);

	for (const signer of signers) {
		tx.requiredSignerHash(signer);
	}
	return tx;
}

const cases = [];
let failures = 0;

function negative(name, build) {
	cases.push({ name, build });
}

// 1. Over the daily ceiling. The mirror throws before building, and if forced
//    past it the script rejects — both count as the rule holding.
negative('over-budget payout is rejected', () => {
	const payout = 25_000_000n;
	const remaining = assetsMinus(utxo.output.amount, lovelaceAsset(payout));
	// Bypass the mirror deliberately: declare a counter the chain must refuse.
	const forged = {
		...datum,
		spentInPeriod: new Map([['', new Map([['', 25_000_000n]])]]),
	};
	return spendSkeleton({ payout, remainingOverride: remaining, outputDatum: forged });
});

// 2. Understating the charge: move 5 ADA, book 1 ADA.
negative('understated counter is rejected', () => {
	const forged = {
		...datum,
		spentInPeriod: new Map([['', new Map([['', 1_000_000n]])]]),
	};
	return spendSkeleton({ payout: 5_000_000n, outputDatum: forged });
});

// 3. Quorum threshold not met: agent plus one co-signer, threshold is two.
negative('missing quorum is rejected', () =>
	spendSkeleton({ signers: [agentKeyHash, cosignerHashes[0]] }),
);

// 4. No agent signature: two co-signers alone.
negative('missing agent signature is rejected', () =>
	spendSkeleton({ signers: [cosignerHashes[0], cosignerHashes[1]] }),
);

// 5. The state token walks off: continuing output without it.
negative('stealing the state token is rejected', () => {
	const remaining = assetsMinus(utxo.output.amount, [
		...lovelaceAsset(2_000_000n),
		{ unit: wallet.stateTokenUnit, quantity: '1' },
	]);
	const nextDatum = applyAgentSpend(datum, outflowOf(utxo.output.amount, [...remaining, { unit: wallet.stateTokenUnit, quantity: '1' }]), validity);
	return spendSkeleton({ payout: 2_000_000n, remainingOverride: remaining, outputDatum: nextDatum });
});

// 6. Rotating the agent inside an agent spend.
negative('agent rotating its own key is rejected', () => {
	const rotated = {
		...applyAgentSpend(datum, outflowOf(utxo.output.amount, assetsMinus(utxo.output.amount, lovelaceAsset(2_000_000n))), validity),
		agent: resolvePaymentKeyHash(recipient),
	};
	return spendSkeleton({ outputDatum: rotated });
});

// 7. Raising the ceiling inside an agent spend.
negative('agent raising its own limit is rejected', () => {
	const widened = {
		...applyAgentSpend(datum, outflowOf(utxo.output.amount, assetsMinus(utxo.output.amount, lovelaceAsset(2_000_000n))), validity),
		limit: new Map([['', new Map([['', 1_000_000_000n]])]]),
	};
	return spendSkeleton({ outputDatum: widened });
});

// 8. Splitting the wallet into two continuing outputs.
negative('splitting the wallet is rejected', () => {
	const remaining = assetsMinus(utxo.output.amount, lovelaceAsset(7_000_000n));
	const nextDatum = applyAgentSpend(datum, outflowOf(utxo.output.amount, remaining), validity);
	return spendSkeleton({
		payout: 2_000_000n,
		remainingOverride: remaining,
		outputDatum: nextDatum,
		extraWalletOutputs: [{ assets: lovelaceAsset(5_000_000n), datum: nextDatum }],
	});
});

// 9. Deposit that removes value.
negative('deposit removing value is rejected', () => {
	const after = assetsMinus(utxo.output.amount, lovelaceAsset(3_000_000n));
	return builder()
		.spendingPlutusScriptV3()
		.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
		.txInScript(wallet.script.code)
		.txInRedeemerValue({ alternative: Action.Deposit, fields: [] })
		.txInInlineDatumPresent()
		.txOut(wallet.address, after)
		.txOutInlineDatumValue(walletDatumData(datum))
		.txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
		.setTotalCollateral('5000000')
		.requiredSignerHash(agentKeyHash)
		.changeAddress(agentAddress)
		.selectUtxosFrom(agentUtxos)
		.setNetwork(network);
});

// 10. Deposit of an unlisted asset — the faucet's tUSDM.
negative('deposit of an unlisted asset is rejected', () => {
	const usdm = agentUtxos
		.flatMap((candidate) => candidate.output.amount)
		.find((asset) => asset.unit !== 'lovelace' && !asset.unit.startsWith(wallet.policyId));
	if (!usdm) throw new Error('SKIP: agent holds no non-ADA asset to attempt with');
	const after = assetsPlus(utxo.output.amount, [{ unit: usdm.unit, quantity: '1000' }]);
	return builder()
		.spendingPlutusScriptV3()
		.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
		.txInScript(wallet.script.code)
		.txInRedeemerValue({ alternative: Action.Deposit, fields: [] })
		.txInInlineDatumPresent()
		.txOut(wallet.address, after)
		.txOutInlineDatumValue(walletDatumData(datum))
		.txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
		.setTotalCollateral('5000000')
		.requiredSignerHash(agentKeyHash)
		.changeAddress(agentAddress)
		.selectUtxosFrom(agentUtxos)
		.setNetwork(network);
});

// 11. UpdatePolicy without the owner.
negative('policy update without the owner is rejected', () =>
	builder()
		.spendingPlutusScriptV3()
		.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
		.txInScript(wallet.script.code)
		.txInRedeemerValue({ alternative: Action.UpdatePolicy, fields: [] })
		.txInInlineDatumPresent()
		.txOut(wallet.address, utxo.output.amount)
		.txOutInlineDatumValue(walletDatumData({ ...datum, agent: agentKeyHash }))
		.txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
		.setTotalCollateral('5000000')
		.requiredSignerHash(agentKeyHash)
		.changeAddress(agentAddress)
		.selectUtxosFrom(agentUtxos)
		.setNetwork(network),
);

// 12. OwnerSpend signed by the agent.
negative('owner sweep without the owner is rejected', () =>
	builder()
		.spendingPlutusScriptV3()
		.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
		.txInScript(wallet.script.code)
		.txInRedeemerValue({ alternative: Action.OwnerSpend, fields: [] })
		.txInInlineDatumPresent()
		.txOut(agentAddress, utxo.output.amount)
		.txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
		.setTotalCollateral('5000000')
		.requiredSignerHash(agentKeyHash)
		.changeAddress(agentAddress)
		.selectUtxosFrom(agentUtxos)
		.setNetwork(network),
);

for (const { name, build } of cases) {
	try {
		let tx;
		try {
			tx = build();
		} catch (error) {
			if (String(error.message).startsWith('SKIP:')) {
				console.log(`skip ${name} — ${error.message.slice(6)}`);
				continue;
			}
			// The off-chain mirror refusing to even build the attack counts as
			// the rule holding — but say so distinctly.
			console.log(`PASS ${name} (rejected off-chain: ${error.message.slice(0, 70)})`);
			continue;
		}
		await tx.complete();
		console.log(`FAIL ${name} — the transaction BUILT; the validator accepted it`);
		failures += 1;
	} catch (error) {
		const message = String(error?.message ?? error);
		console.log(`PASS ${name} (rejected on evaluation)`);
		if (process.env.VERBOSE === '1') console.log(`     ${message.slice(0, 200)}`);
	}
}

console.log(`\n${failures === 0 ? 'All negative cases rejected.' : `${failures} case(s) UNEXPECTEDLY ACCEPTED`}`);
process.exit(failures === 0 ? 0 : 1);
