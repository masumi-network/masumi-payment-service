import { Network } from '@/generated/prisma/client';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import {
	type MeshLikeUtxo,
	type ProjectableMeshLikeUtxo,
	type ProjectableWalletUtxo,
	type WalletBalanceCheckSource,
	toBalanceMapFromMeshUtxos,
	walletLowBalanceMonitorService,
} from '@/services/wallets';

export type WalletSession = Awaited<ReturnType<typeof generateWalletExtended>> & {
	hotWalletId: string;
	checkSource: WalletBalanceCheckSource;
	evaluateProjectedBalance: (
		unsignedTx: string,
		walletUtxos?: Array<ProjectableMeshLikeUtxo | ProjectableWalletUtxo>,
	) => Promise<void>;
};

export async function loadHotWalletSession(params: {
	network: Network;
	rpcProviderApiKey: string;
	encryptedMnemonic: string;
	hotWalletId: string;
	checkSource?: WalletBalanceCheckSource;
	evaluateBalance?: boolean;
}): Promise<WalletSession> {
	const checkSource = params.checkSource ?? 'submission';
	const session = await generateWalletExtended(params.network, params.rpcProviderApiKey, params.encryptedMnemonic);

	if (params.evaluateBalance !== false) {
		await walletLowBalanceMonitorService.evaluateHotWalletById(
			params.hotWalletId,
			toBalanceMapFromMeshUtxos(session.utxos as MeshLikeUtxo[]),
			checkSource,
		);
	}

	return {
		...session,
		hotWalletId: params.hotWalletId,
		checkSource,
		evaluateProjectedBalance: async (
			unsignedTx: string,
			walletUtxos?: Array<ProjectableMeshLikeUtxo | ProjectableWalletUtxo>,
		) => {
			await walletLowBalanceMonitorService.evaluateProjectedHotWalletById({
				hotWalletId: params.hotWalletId,
				walletAddress: session.address,
				walletUtxos: walletUtxos ?? session.utxos,
				unsignedTx,
				checkSource,
			});
		},
	};
}
