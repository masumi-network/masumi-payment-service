import { Network } from '@/generated/prisma/client';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { SLOT_CONFIG_NETWORK, Transaction, UTxO, unixTimeToEnclosingSlot } from '@meshsdk/core';

export type FundDistributionOutput = {
	address: string;
	lovelace: bigint;
};

export type FundDistributionTxResult = {
	txHash: string;
	signedTx: string;
	utxos: UTxO[];
};

export async function buildAndSubmitFundDistributionTx(params: {
	encryptedMnemonic: string;
	network: Network;
	rpcProviderApiKey: string;
	outputs: FundDistributionOutput[];
}): Promise<FundDistributionTxResult> {
	const { encryptedMnemonic, network, rpcProviderApiKey, outputs } = params;

	const { wallet, blockchainProvider, utxos } = await generateWalletExtended(
		network,
		rpcProviderApiKey,
		encryptedMnemonic,
	);

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
	const invalidAfter = unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[meshNetwork]) + 5;

	unsignedTx.setNetwork(meshNetwork);
	unsignedTx.txBuilder.invalidBefore(invalidBefore);
	unsignedTx.txBuilder.invalidHereafter(invalidAfter);

	const completeTx = await unsignedTx.build();
	const signedTx = await wallet.signTx(completeTx);
	const txHash = await wallet.submitTx(signedTx);

	return { txHash, signedTx, utxos };
}
