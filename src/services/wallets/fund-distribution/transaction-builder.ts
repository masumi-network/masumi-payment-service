import { Network } from '@/generated/prisma/client';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { Transaction } from '@/services/shared';
import { SLOT_CONFIG_NETWORK, resolveTxHash, unixTimeToEnclosingSlot } from '@meshsdk/core';

/**
 * Fund distribution builds a PURE VALUE TRANSFER (fund wallet → hot wallet
 * addresses, lovelace only; no datum, redeemer or script witness). Per the
 * ADR-0005 carve-out documented in `@/services/shared`, pure value-tx CBOR is
 * stable across the two mesh lines in use (1.9.0-beta.96 ↔ .102), so building
 * here with the root-pinned V1 mesh is correct for BOTH Web3CardanoV1 and
 * Web3CardanoV2 payment sources — the recipient's source type never affects a
 * plain address-to-address payment. `Transaction` comes from
 * `@/services/shared` rather than `@meshsdk/core` directly so that carve-out
 * stays explicit and MeshWallet instances stay `instanceof`-consistent.
 *
 * Do NOT extend this builder to spend from a script address: that introduces a
 * script-data-hash, and the mesh line would then matter.
 */

export type FundDistributionOutput = {
	address: string;
	lovelace: bigint;
};

export type FundDistributionSignedTx = {
	signedTx: string;
	/**
	 * Deterministic hash of the signed body, available BEFORE broadcast so an
	 * ambiguous `submitTx` outcome can be resolved against the chain by the
	 * funding-reconciliation worker rather than blindly re-sent.
	 */
	intendedTxHash: string;
	/** Slot after which the ledger can never accept this body. */
	invalidHereafterSlot: number;
	submit: () => Promise<string>;
};

/**
 * Builds and signs the distribution tx WITHOUT submitting. The caller MUST
 * persist `intendedTxHash` + `invalidHereafterSlot` before calling `submit()`,
 * mirroring the funding double-lock guarantee in
 * `packages/payment-source-v2/src/services/purchases/batch-payments/service.ts`.
 * Splitting build/sign from submit is what makes an ambiguous broadcast
 * recoverable instead of a double-send.
 */
export async function buildAndSignFundDistributionTx(params: {
	encryptedMnemonic: string;
	network: Network;
	rpcProviderApiKey: string;
	outputs: FundDistributionOutput[];
}): Promise<FundDistributionSignedTx> {
	const { encryptedMnemonic, network, rpcProviderApiKey, outputs } = params;

	const { wallet, blockchainProvider } = await generateWalletExtended(network, rpcProviderApiKey, encryptedMnemonic);

	const meshNetwork = convertNetwork(network);

	const unsignedTx = new Transaction({
		initiator: wallet,
		fetcher: blockchainProvider,
	}).setMetadata(674, {
		msg: ['Masumi', 'FundDistribution'],
	});

	for (const output of outputs) {
		unsignedTx.sendLovelace(output.address, output.lovelace.toString());
	}

	const invalidBefore = unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK[meshNetwork]) - 1;
	const invalidHereafterSlot = unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[meshNetwork]) + 5;

	unsignedTx.setNetwork(meshNetwork);
	unsignedTx.txBuilder.invalidBefore(invalidBefore);
	unsignedTx.txBuilder.invalidHereafter(invalidHereafterSlot);

	const completeTx = await unsignedTx.build();
	const signedTx = await wallet.signTx(completeTx);

	return {
		signedTx,
		intendedTxHash: resolveTxHash(signedTx),
		invalidHereafterSlot,
		submit: () => wallet.submitTx(signedTx),
	};
}
