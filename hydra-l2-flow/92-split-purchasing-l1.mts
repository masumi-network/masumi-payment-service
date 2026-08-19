/**
 * Split the purchasing wallet's faucet-contaminated L1 UTxO into pure ADA.
 *
 * The preprod faucet bundles tUSDM onto the ADA it sends, so the wallet's only
 * large UTxO carries a token. Two things need pure ADA before a head can open:
 * the commit candidate itself, and a strictly larger UTxO left behind as fuel
 * for the node's own transactions. One contaminated UTxO satisfies neither.
 *
 * Produces: a minimal UTxO holding all the token, two large pure UTxOs (commit
 * candidate + fuel), and pure change.
 *
 * Run: pnpm exec tsx hydra-l2-flow/92-split-purchasing-l1.mts [commitAda] [fuelAda]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { BlockfrostProvider, MeshTxBuilder, MeshWallet } from '@meshsdk/core';

const PREPROD_DIR = join(process.cwd(), 'hydra-l2-flow', 'preprod');
const COMMIT_ADA = BigInt(process.argv[2] ?? '500') * 1_000_000n;
const FUEL_ADA = BigInt(process.argv[3] ?? '250') * 1_000_000n;
const TOKEN_HOLDER_LOVELACE = 2_000_000n;

function log(m: string) {
	console.log(`[split-l1] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function purchasingAddress(): string {
	return execSync(
		`docker run --rm -v ${JSON.stringify(PREPROD_DIR)}:/keys --entrypoint cardano-cli ghcr.io/intersectmbo/cardano-node:10.6.2 ` +
			`address build --payment-verification-key-file /keys/purchasing-cardano.vk --testnet-magic 1`,
		{ encoding: 'utf-8' },
	).trim();
}

async function main() {
	const projectId = readFileSync(join(PREPROD_DIR, 'blockfrost.txt'), 'utf-8').trim();
	const provider = new BlockfrostProvider(projectId);
	const address = purchasingAddress();
	log(`purchasing address ${address}`);

	const utxos = await provider.fetchAddressUTxOs(address);
	const contaminated = utxos
		.filter((u) => u.output.amount.length > 1)
		.sort((a, b) => {
			const lovelace = (x: typeof a) => BigInt(x.output.amount.find((v) => v.unit === 'lovelace')?.quantity ?? '0');
			return Number(lovelace(b) - lovelace(a));
		})[0];
	if (!contaminated) throw new Error('no token-bearing UTxO to split — nothing to do');

	const total = BigInt(contaminated.output.amount.find((v) => v.unit === 'lovelace')?.quantity ?? '0');
	const tokens = contaminated.output.amount.filter((v) => v.unit !== 'lovelace');
	log(`splitting ${total} lovelace carrying ${tokens.length} token unit(s)`);
	if (total < COMMIT_ADA + FUEL_ADA + TOKEN_HOLDER_LOVELACE + 5_000_000n) {
		throw new Error(`UTxO holds ${total}, too little for commit ${COMMIT_ADA} + fuel ${FUEL_ADA}`);
	}

	// Every pure-ADA UTxO is a potential input too: the builder needs one for the
	// fee, and spending them here keeps the wallet tidy rather than fragmented.
	const builder = new MeshTxBuilder({ fetcher: provider, submitter: provider, verbose: false });
	builder.txIn(
		contaminated.input.txHash,
		contaminated.input.outputIndex,
		contaminated.output.amount,
		contaminated.output.address,
	);

	builder
		// All of the token, parked in its own minimal UTxO and out of the way.
		.txOut(address, [
			{ unit: 'lovelace', quantity: TOKEN_HOLDER_LOVELACE.toString() },
			...tokens.map((t) => ({ unit: t.unit, quantity: t.quantity })),
		])
		.txOut(address, [{ unit: 'lovelace', quantity: COMMIT_ADA.toString() }])
		.txOut(address, [{ unit: 'lovelace', quantity: FUEL_ADA.toString() }])
		.changeAddress(address)
		.setNetwork('preprod');

	const unsigned = await builder.complete();

	// Signed with the node's own Cardano key via cardano-cli: this key is a plain
	// payment key file, not a mnemonic wallet.
	const signed = signWithCli(unsigned);
	const txHash = await provider.submitTx(signed);
	log(`submitted ${txHash}`);
	log(`commit candidate ${COMMIT_ADA / 1_000_000n} tADA, fuel ${FUEL_ADA / 1_000_000n} tADA, token parked separately`);
	log('wait for it to confirm on preprod before opening the head');
}

function signWithCli(cborHex: string): string {
	const body = JSON.stringify({ type: 'Unwitnessed Tx ConwayEra', description: '', cborHex });
	const signed = execSync(
		`docker run --rm -i -v ${JSON.stringify(PREPROD_DIR)}:/keys --entrypoint sh ghcr.io/intersectmbo/cardano-node:10.6.2 -c ` +
			JSON.stringify(
				'cat > /tmp/d.tx && cardano-cli conway transaction sign --tx-file /tmp/d.tx ' +
					'--signing-key-file /keys/purchasing-cardano.sk --testnet-magic 1 --out-file /tmp/s.tx && cat /tmp/s.tx',
			),
		{ input: body, encoding: 'utf-8' },
	);
	return (JSON.parse(signed) as { cborHex: string }).cborHex;
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
