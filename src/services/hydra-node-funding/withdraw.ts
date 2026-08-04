/**
 * Returning a finished node's fuel to the wallet that supplied it.
 *
 * Without this the fuel is not a float, it is a cost: a node serves exactly one
 * head and is never reused, so every head permanently strands whatever its node
 * did not spend. At any volume that is a leak rather than an untidiness.
 *
 * Two things make this different from the funding path, which is why it lives
 * apart from it. It spends from the *node's* key rather than a hot wallet, so
 * the signature comes from `HydraSecretKey.cardanoSK`. And the funds sit at an
 * enterprise address, which the wallet's own coin selection will not find —
 * MeshWallet derives a base address from a CLI key and ignores `addressType` on
 * the pinned V1 line — so the inputs are named explicitly and the wallet is used
 * for its signature alone.
 *
 * A pure value transfer, so the ADR-0005 carve-out applies and building on the
 * root-pinned V1 mesh is correct for a node belonging to either source type.
 */

import createHttpError from 'http-errors';
import { MeshTxBuilder, MeshWallet, resolveTxHash, type Asset, type UTxO } from '@meshsdk/core';
import { HydraHeadStatus, HydraInviteStatus, Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decrypt } from '@/utils/security/encryption';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { getCachedBlockfrostProvider } from '@/utils/mesh-cost-model-sync';
import { nodeCardanoAddress } from './node-address';

/**
 * Below this, sweeping costs more than it returns.
 *
 * The transaction pays its own fee out of the balance being swept, so dust is
 * best left where it is rather than turned into a slightly larger loss.
 */
export const MINIMUM_WITHDRAWABLE_LOVELACE = 2_000_000n;

export type NodeWithdrawal = {
	address: string;
	balanceLovelace: string;
	txHash: string | null;
	/** Why nothing was swept, when nothing was. */
	reason: string | null;
};

/**
 * Head states in which the node still owes an on-chain transaction.
 *
 * Taking its fuel before then is the expensive mistake: a node that cannot pay
 * for its own Fanout leaves the committed funds behind a contestation deadline,
 * which is far worse than leaving a few ADA behind.
 */
export function reasonHeadIsNotDone(status: HydraHeadStatus | undefined): string | null {
	if (status === undefined || status === HydraHeadStatus.Final) {
		return null;
	}
	return (
		`the head is ${status}, so its node still has to pay for closing, contesting and fanning out, ` +
		'so its fuel stays until the head is final'
	);
}

/**
 * Sweep a node's remaining lovelace back to the wallet that funded it.
 *
 * Submits directly rather than queueing. Unlike a top-up there is no split to
 * confirm first and nothing downstream waits on it, so the operator who asked
 * gets the transaction hash rather than a promise to look again later.
 */
export async function withdrawNodeFunds(localParticipantId: string): Promise<NodeWithdrawal> {
	const participant = await prisma.hydraLocalParticipant.findUniqueOrThrow({
		where: { id: localParticipantId },
		include: {
			Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } },
			HydraHead: { select: { status: true } },
			HydraSecretKey: true,
		},
	});

	const network: Network = participant.Wallet.PaymentSource.network;
	const address = nodeCardanoAddress(participant.cardanoVkey, network);

	const notDone = reasonHeadIsNotDone(participant.HydraHead?.status);
	if (notDone !== null) {
		return { address, balanceLovelace: '0', txHash: null, reason: notDone };
	}

	// A node with no head is not necessarily finished: it may be reserved by an
	// invite nobody has redeemed yet. The funding cycle keeps such a node topped
	// up precisely so it can post its Init the moment someone does, and sweeping
	// it would make that redemption fail with NoSeedInput.
	if (participant.hydraHeadId === null) {
		const liveInvite = await prisma.hydraHeadInvite.findFirst({
			where: {
				hydraHostId: participant.hydraHostId,
				hostNodeId: participant.hostNodeId,
				status: { in: [HydraInviteStatus.Issued, HydraInviteStatus.Redeemed, HydraInviteStatus.Started] },
			},
			select: { status: true },
		});
		if (liveInvite !== null) {
			return {
				address,
				balanceLovelace: '0',
				txHash: null,
				reason: 'an invite is still holding this node, so it needs its funds to open the head. Revoke the invite first',
			};
		}
	}

	const provider = getCachedBlockfrostProvider(participant.Wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey);

	let utxos: UTxO[];
	try {
		utxos = await provider.fetchAddressUTxOs(address);
	} catch (error) {
		// An address that has never been used is empty, not broken.
		logger.warn(`hydra: could not read node address ${address}: ${(error as Error).message}`);
		return { address, balanceLovelace: '0', txHash: null, reason: 'the chain could not be consulted for this node' };
	}

	const balance = utxos.reduce(
		(total: bigint, utxo: UTxO) =>
			total + BigInt(utxo.output.amount.find((asset: Asset) => asset.unit === 'lovelace')?.quantity ?? '0'),
		0n,
	);

	if (balance <= MINIMUM_WITHDRAWABLE_LOVELACE) {
		return {
			address,
			balanceLovelace: balance.toString(),
			txHash: null,
			reason: `only ${balance} lovelace is left, which would cost more in fees than it returns`,
		};
	}

	// Nodes provisioned before the Cardano key was captured cannot be swept: the
	// key exists only on the Host, and without it nothing here can authorise a
	// spend from that address.
	const nodeSigningKey = participant.HydraSecretKey?.cardanoSK ?? null;
	if (nodeSigningKey === null) {
		return {
			address,
			balanceLovelace: balance.toString(),
			txHash: null,
			reason: 'this node has no stored Cardano signing key here, so its funds cannot be moved from this service',
		};
	}

	// Signs only. Its own derived address is a base address and therefore not
	// where these funds are, which is exactly why the inputs are named below
	// rather than selected by the wallet.
	const signer = new MeshWallet({
		networkId: convertNetworkToId(network),
		fetcher: provider,
		submitter: provider,
		key: { type: 'cli', payment: decrypt(nodeSigningKey) },
	});

	const builder = new MeshTxBuilder({ fetcher: provider, submitter: provider, verbose: false });
	for (const utxo of utxos) {
		builder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
	}

	// Everything lands as change at the funding wallet, which is what makes this
	// a sweep rather than a payment leaving a remainder behind.
	const unsignedTx = await builder
		.changeAddress(participant.Wallet.walletAddress)
		.setNetwork(convertNetwork(network))
		.complete();

	const signedTx = await signer.signTx(unsignedTx, true);
	// Same types-only bridge as the fund-transfer builder: V1 mesh types this as
	// `any`, V2 as `string`, and the implementation is identical.
	const intendedTxHash = resolveTxHash(signedTx) as string;

	try {
		const txHash = await signer.submitTx(signedTx);
		logger.info(`hydra: withdrew ${balance} lovelace from node ${participant.hostNodeId} in ${txHash}`);
		return { address, balanceLovelace: balance.toString(), txHash, reason: null };
	} catch (error) {
		// The hash is reported even on an ambiguous submit: the transaction may
		// well be on chain, and re-sweeping the same inputs would fail anyway.
		logger.warn(
			`hydra: withdrawal ${intendedTxHash} from node ${participant.hostNodeId} may not have been accepted: ${(error as Error).message}`,
		);
		throw createHttpError(
			502,
			`the withdrawal could not be confirmed as submitted (${intendedTxHash}). Check the address before retrying`,
		);
	}
}
