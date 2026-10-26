/** L1 inputs of deposits that returned to the local wallet instead of entering the head. */

import { HydraTopupStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { getBlockfrostInstance } from '@/utils/blockfrost';

export async function getRecoveredHydraInputRefs(hydraHeadId: string): Promise<ReadonlySet<string>> {
	const recovered = await prisma.hydraTopup.findMany({
		where: { hydraHeadId, status: HydraTopupStatus.Recovered },
		select: { depositTxHash: true },
	});
	const refs = new Set<string>();
	if (recovered.length === 0) return refs;

	const head = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
		select: {
			LocalParticipant: {
				select: {
					Wallet: {
						select: {
							walletAddress: true,
							PaymentSource: {
								select: { network: true, PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
							},
						},
					},
				},
			},
		},
	});
	const wallet = head?.LocalParticipant?.Wallet;
	if (!wallet) throw new Error(`Hydra head ${hydraHeadId} has no local wallet for recovered-deposit checks`);
	const chain = getBlockfrostInstance(
		wallet.PaymentSource.network,
		wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
	);
	for (const deposit of recovered) {
		if (deposit.depositTxHash === null) {
			throw new Error(`Recovered Hydra deposit in head ${hydraHeadId} has no deposit transaction hash`);
		}
		const transaction = await chain.txsUtxos(deposit.depositTxHash);
		for (const input of transaction.inputs) {
			if (input.address === wallet.walletAddress && !input.collateral && !input.reference) {
				refs.add(`${input.tx_hash}#${input.output_index}`.toLowerCase());
			}
		}
	}
	return refs;
}
