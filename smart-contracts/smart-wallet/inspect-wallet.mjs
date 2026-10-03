import 'dotenv/config';
import {
	assetValueEntries,
	assetValueGet,
	blockchainProvider,
	hasSeed,
	loadSmartWalletScript,
	lovelaceOf,
	readWalletDatum,
} from './example-helpers.mjs';

if (!hasSeed()) {
	throw new Error('wallet-seed.json not found. Run pnpm run init first.');
}

const wallet = loadSmartWalletScript();
const utxos = await blockchainProvider.fetchAddressUTxOs(wallet.address);

console.log(`Smart wallet
    Address: ${wallet.address}
    Policy id (= script hash): ${wallet.policyId}
    State token: ${wallet.stateTokenUnit}
    Seed: ${wallet.seed.txHash}#${wallet.seed.outputIndex}
    Owner: ${wallet.owner}
    Quorum: ${wallet.threshold} of ${wallet.quorum.length} — ${wallet.quorum.join(', ')}
    UTxOs at address: ${utxos.length}
`);

// Shows THE wallet named by wallet-seed.json, not the fleet: sibling wallets
// at the shared address carry different token names and are skipped here.
const held = utxos.filter((utxo) =>
	utxo.output.amount.some((asset) => asset.unit === wallet.stateTokenUnit),
);

if (held.length === 0) {
	console.log('No UTxO carries the state token. The wallet is not created, or has been retired.');
	if (utxos.length > 0) {
		console.log(`${utxos.length} UTxO(s) sit at the address without the token — only OwnerSpend can move them.`);
	}
	process.exit(0);
}

const now = BigInt(Date.now());

for (const utxo of held) {
	const datum = readWalletDatum(utxo);
	const windowEnd = datum.periodStart + datum.periodLength;
	const elapsed = now >= windowEnd;

	console.log(`  ${utxo.input.txHash}#${utxo.input.outputIndex}`);
	console.log(`    balance: ${lovelaceOf(utxo.output.amount)} lovelace`);
	console.log(`    agent: ${datum.agent}`);
	console.log(`    min balance: ${datum.minBalanceLovelace} lovelace`);
	console.log(`    window: ${datum.periodStart} .. ${windowEnd}${elapsed ? ' (elapsed, resets on next spend)' : ''}`);

	for (const { policyId, assetName } of assetValueEntries(datum.limit)) {
		const allowed = assetValueGet(datum.limit, policyId, assetName) ?? 0n;
		const spent = assetValueGet(datum.spentInPeriod, policyId, assetName) ?? 0n;
		const available = elapsed ? allowed : allowed - spent;
		const label = policyId === '' ? 'lovelace' : `${policyId}.${assetName}`;
		console.log(`    ${label}: ${spent} / ${allowed} used, ${available < 0n ? 0n : available} spendable now`);
	}

	// Anything the wallet holds that is not budgeted cannot move under an agent
	// spend at all — the freeze applies in both directions.
	const frozen = utxo.output.amount.filter(
		(asset) =>
			asset.unit !== 'lovelace' &&
			asset.unit !== wallet.stateTokenUnit &&
			assetValueGet(datum.limit, asset.unit.slice(0, 56), asset.unit.slice(56)) === undefined,
	);
	if (frozen.length > 0) {
		console.log(`    frozen (no limit entry, owner-only): ${frozen.map((a) => a.unit).join(', ')}`);
	}
}
