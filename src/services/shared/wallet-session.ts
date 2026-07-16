import { Network } from '@/generated/prisma/client';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import {
	type BalanceMap,
	type ProjectableMeshLikeUtxo,
	type ProjectableWalletUtxo,
	type WalletBalanceCheckSource,
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
	let currentBalanceMap: BalanceMap | null = null;

	if (params.evaluateBalance !== false) {
		currentBalanceMap = await walletLowBalanceMonitorService.evaluateCurrentHotWalletById(
			params.hotWalletId,
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
				currentBalanceMap: currentBalanceMap ?? undefined,
			});
		},
	};
}
