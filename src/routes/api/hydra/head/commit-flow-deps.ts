import { resolvePaymentKeyHash, type UTxO } from '@meshsdk/core';
import type { HydraCommitFlowDeps } from '@/lib/hydra';
import type { HydraTransaction } from '@/lib/hydra';

/** Minimal structural views of the runtime objects the commit flow drives. */
type CommitDraftingHead = {
	commit: (commitUtxos: UTxO[], blueprint: null, walletId: string) => Promise<HydraTransaction | undefined>;
};
type PartialSigningWallet = { signTx: (cborHex: string, partialSign: boolean) => Promise<string> };
type UtxoResolvingProvider = { fetchUTxOs: (txHash: string, index?: number) => Promise<UTxO[]> };

/**
 * Wire the pure commit-flow orchestration to the concrete hydra-node head, mesh
 * wallet and L1 provider. Shared by the initial-commit and top-up endpoints so
 * both drive the identical draft → input-safety → validate → sign path.
 */
export function buildHydraCommitFlowDeps(params: {
	hydraHead: CommitDraftingHead;
	wallet: PartialSigningWallet;
	blockchainProvider: UtxoResolvingProvider;
	walletId: string;
}): HydraCommitFlowDeps {
	return {
		requestCommitDraft: (commitUtxos) => params.hydraHead.commit(commitUtxos, null, params.walletId),
		signTx: (cborHex, partialSign) => params.wallet.signTx(cborHex, partialSign),
		resolveInputOutput: async (txHash, index) =>
			(await params.blockchainProvider.fetchUTxOs(txHash, index)).find((utxo) => utxo.input.outputIndex === index)
				?.output ?? null,
		paymentKeyHashOf: resolvePaymentKeyHash,
	};
}
