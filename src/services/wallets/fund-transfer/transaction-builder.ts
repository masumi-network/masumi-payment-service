import { Network } from '@/generated/prisma/client';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { Transaction, createTxWindow } from '@/services/shared';
import { resolveTxHash } from '@meshsdk/core';

/**
 * A fund transfer is a PURE VALUE TRANSFER (hot wallet → an arbitrary address,
 * lovelace plus any native tokens; no datum, redeemer or script witness). Per
 * the ADR-0005 carve-out documented in `@/services/shared`, pure value-tx CBOR
 * is stable across the two mesh lines in use (1.9.0-beta.96 ↔ .102), so
 * building here with the root-pinned V1 mesh is correct for a hot wallet that
 * belongs to EITHER a Web3CardanoV1 or a Web3CardanoV2 payment source — the
 * source type never affects a plain address-to-address payment. `Transaction`
 * comes from `@/services/shared` rather than `@meshsdk/core` directly so that
 * carve-out stays explicit and MeshWallet instances stay
 * `instanceof`-consistent.
 *
 * Do NOT extend this builder to spend from a script address: that introduces a
 * script-data-hash, and the mesh line would then matter.
 */

export type FundTransferSignedTx = {
	signedTx: string;
	/**
	 * Deterministic hash of the signed body, available BEFORE broadcast so an
	 * ambiguous `submitTx` outcome can be resolved against the chain by the
	 * confirmation job (or the shared funding-reconciliation worker) rather than
	 * blindly re-sent.
	 */
	intendedTxHash: string;
	/** Slot after which the ledger can never accept this body. */
	invalidHereafterSlot: number;
	submit: () => Promise<string>;
};

/**
 * Builds and signs the transfer tx WITHOUT submitting. The caller MUST persist
 * `intendedTxHash` + `invalidHereafterSlot` before calling `submit()`,
 * mirroring the funding double-lock guarantee in
 * `packages/payment-source-v2/src/services/purchases/batch-payments/service.ts`.
 * Splitting build/sign from submit is what makes an ambiguous broadcast
 * recoverable instead of a double-send.
 */
export async function buildAndSignFundTransferTx(params: {
	encryptedMnemonic: string;
	network: Network;
	rpcProviderApiKey: string;
	toAddress: string;
	assets: Array<{ unit: string; quantity: bigint }>;
}): Promise<FundTransferSignedTx> {
	const { encryptedMnemonic, network, rpcProviderApiKey, toAddress, assets } = params;

	const { wallet, blockchainProvider } = await generateWalletExtended(network, rpcProviderApiKey, encryptedMnemonic);

	const meshNetwork = convertNetwork(network);

	const unsignedTx = new Transaction({
		initiator: wallet,
		fetcher: blockchainProvider,
	}).setMetadata(674, {
		msg: ['Masumi', 'FundTransfer'],
	});

	// One output carrying ADA and any native tokens together. Quantities are
	// strings because lovelace and token amounts both exceed Number's safe range.
	unsignedTx.sendAssets(
		toAddress,
		assets.map((asset) => ({ unit: asset.unit, quantity: asset.quantity.toString() })),
	);

	// Shared window helper so this builder agrees with every other one on
	// validity bounds. A plain payment has no on-chain deadline to constrain
	// against; invalidHereafter is what bounds the recovery TTL.
	const { invalidBefore, invalidAfter: invalidHereafterSlot } = createTxWindow(meshNetwork);

	unsignedTx.setNetwork(meshNetwork);
	unsignedTx.txBuilder.invalidBefore(invalidBefore);
	unsignedTx.txBuilder.invalidHereafter(invalidHereafterSlot);

	const completeTx = await unsignedTx.build();
	const signedTx = await wallet.signTx(completeTx);

	// V1 mesh (beta.96, which this root-level file resolves) declares
	// `resolveTxHash: (txHex: string) => any`; V2 mesh (beta.102) declares it
	// `=> string`. Same blake2b_256-over-signed-body implementation, tightened
	// typings only — so the cast is a types-only bridge, not a behavioural
	// assumption. Drop it if the root ever moves to the .102 line.
	const intendedTxHash = resolveTxHash(signedTx) as string;

	return {
		signedTx,
		intendedTxHash,
		invalidHereafterSlot,
		submit: () => wallet.submitTx(signedTx),
	};
}
