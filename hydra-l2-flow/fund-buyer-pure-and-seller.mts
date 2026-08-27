/**
 * In-head remediation for faucet-token contamination.
 *
 * The preprod faucet bundled a native token (tUSDM) onto the ADA that funded the
 * buyer wallet, so the buyer's large in-head UTxO carries that token. The V2 L2
 * lock only spends PURE-ADA in-head UTxOs, so it was left with just the tiny
 * pure UTxO and failed with "insufficient in-head ADA to lock".
 *
 * This spends the buyer's token-carrying in-head UTxO and re-shapes it into:
 *   - a small UTxO holding ALL the token (buyer)         → keeps token out of the way
 *   - a seller pure-ADA UTxO                             → funds the seller side
 *   - pure-ADA change back to the buyer (the big one)    → what the L2 lock spends
 *
 * In-head tx: instant, zero-fee. Run: pnpm exec tsx hydra-l2-flow/fund-buyer-pure-and-seller.mts
 */
import { MeshTxBuilder } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { HotWalletType, HydraHeadStatus, Network } from '@/generated/prisma/client';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraProvider } from '@/lib/hydra/hydra/provider';
import { decrypt } from '@/utils/security/encryption';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';

const SELLER_FUND_LOVELACE = '15000000'; // 15 ADA to the seller (pure)
const TOKEN_HOLDER_LOVELACE = '2000000'; // 2 ADA min-UTxO carrying the token

function lovelaceOf(amount: Array<{ unit: string; quantity: string }>): bigint {
	return BigInt(amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0');
}

async function main() {
	const head = await prisma.hydraHead.findFirstOrThrow({
		where: { status: HydraHeadStatus.Open, isEnabled: true, HydraRelation: { network: Network.Preprod } },
		include: {
			LocalParticipant: { include: { Wallet: { include: { Secret: true } } } },
			RemoteParticipants: { include: { Wallet: true } },
		},
		orderBy: { updatedAt: 'desc' },
	});

	const localWallet = head.LocalParticipant?.Wallet;
	const remoteWallet = head.RemoteParticipants[0]?.Wallet;
	if (!localWallet || localWallet.type !== HotWalletType.Purchasing) throw new Error('local wallet is not Purchasing');
	if (!remoteWallet) throw new Error('no remote seller wallet');

	const node = new HydraNode({ httpUrl: head.LocalParticipant!.nodeHttpUrl, wsUrl: head.LocalParticipant!.nodeUrl });
	node.connect();
	await new Promise((r) => setTimeout(r, 1500));
	const provider = new HydraProvider({ node });
	const wallet = generateOfflineWallet(Network.Preprod, decrypt(localWallet.Secret.encryptedMnemonic).split(' '));

	const snapshot = await node.snapshotUTxO();
	// The buyer's in-head UTxO that carries a native token (not pure ADA).
	const tokenUtxo = snapshot
		.filter((u) => u.output.address === localWallet.walletAddress)
		.filter((u) => u.output.amount.some((a) => a.unit !== 'lovelace' && a.unit !== ''))
		.sort((a, b) => Number(lovelaceOf(b.output.amount) - lovelaceOf(a.output.amount)))[0];
	if (!tokenUtxo) {
		console.log('No token-carrying buyer UTxO found — nothing to remediate.');
		await prisma.$disconnect();
		process.exit(0);
	}

	const tokenAssets = tokenUtxo.output.amount.filter((a) => a.unit !== 'lovelace' && a.unit !== '');
	console.log(
		JSON.stringify(
			{
				headId: head.id,
				buyer: localWallet.walletAddress,
				seller: remoteWallet.walletAddress,
				sourceUtxo: `${tokenUtxo.input.txHash.slice(0, 12)}...#${tokenUtxo.input.outputIndex}`,
				sourceLovelace: lovelaceOf(tokenUtxo.output.amount).toString(),
				tokens: tokenAssets,
			},
			null,
			2,
		),
	);

	const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, isHydra: true });
	tx.txIn(tokenUtxo.input.txHash, tokenUtxo.input.outputIndex, tokenUtxo.output.amount, tokenUtxo.output.address, 0)
		// seller pure-ADA UTxO
		.txOut(remoteWallet.walletAddress, [{ unit: 'lovelace', quantity: SELLER_FUND_LOVELACE }])
		// token holder (all tokens + min ADA) back to buyer
		.txOut(localWallet.walletAddress, [
			{ unit: 'lovelace', quantity: TOKEN_HOLDER_LOVELACE },
			...tokenAssets.map((a) => ({ unit: a.unit, quantity: a.quantity })),
		])
		.setFee('0')
		// pure-ADA change (the large UTxO the L2 lock will spend) back to buyer
		.changeAddress(localWallet.walletAddress);
	await tx.complete();

	const signed = await wallet.signTx(tx.txHex);
	const txHash = await provider.submitTx(signed);

	await Promise.race([node.awaitTx(txHash, 500).then(() => true), new Promise((r) => setTimeout(r, 15000))]);

	const after = await node.snapshotUTxO();
	const buyerUtxos = after
		.filter((u) => u.output.address === localWallet.walletAddress)
		.map((u) => ({
			ref: `${u.input.txHash.slice(0, 10)}...#${u.input.outputIndex}`,
			lovelace: lovelaceOf(u.output.amount).toString(),
			pure: u.output.amount.every((a) => a.unit === 'lovelace' || a.unit === ''),
		}));
	const sellerUtxos = after
		.filter((u) => u.output.address === remoteWallet.walletAddress)
		.map((u) => ({
			ref: `${u.input.txHash.slice(0, 10)}...#${u.input.outputIndex}`,
			lovelace: lovelaceOf(u.output.amount).toString(),
		}));

	console.log(JSON.stringify({ txHash, buyerUtxos, sellerUtxos }, null, 2));
	await prisma.$disconnect();
	process.exit(0);
}

main().catch(async (e) => {
	console.error(e);
	await prisma.$disconnect();
	process.exit(1);
});
