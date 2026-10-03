/**
 * Manually commit the buyer (Purchasing) hot wallet's L1 UTxOs into the open
 * preprod head, funding the buyer's in-head balance.
 *
 * Mirrors the service's commit endpoint for out-of-band diagnostics/recovery:
 * draft via /commit → sign with the buyer wallet → submit via the node's
 * /cardano-transaction. The escrow purchase flow (processL2-PurchaseLocks) does
 * not use this helper, so this only affects manual head funding.
 *
 * Run: pnpm exec tsx hydra-l2-flow/fund-head-commit-manual.mts <exact-head-id>
 */
import { prisma } from '@masumi/payment-core/db';
import { HotWalletType, HydraHeadStatus, Network } from '@/generated/prisma/client';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { decrypt } from '@/utils/security/encryption';
import { reconcilePendingHydraCommit, reserveAndSubmitHydraCommit } from '@/services/hydra-commit-reconciliation';
import {
	assertHydraCommitSignedBody,
	deriveHydraVerificationKeyCborHex,
	getHydraPlaintextHosts,
	HydraNode,
	HydraTransactionType,
	interpretCardanoTxSubmitResult,
	mapUTxOToHydraUTxO,
	normalizeHydraVerificationKeyCborHex,
	resolveHydraDepositScriptHash,
	selectCommitUtxosWithFuelReserve,
	type HydraTransaction,
	validateHydraCommitDraft,
	validateHydraNodeUrls,
	verifyHydraHeadInitOnChain,
} from '@/lib/hydra';

async function main() {
	const headId = process.argv[2]?.trim();
	if (!headId) throw new Error('pass the exact enabled Open HydraHead id to fund');
	const head = await prisma.hydraHead.findFirstOrThrow({
		where: {
			id: headId,
			status: HydraHeadStatus.Open,
			isEnabled: true,
			HydraRelation: { network: Network.Preprod },
		},
		include: {
			LocalParticipant: {
				include: {
					HydraSecretKey: true,
					Wallet: { include: { Secret: true, PaymentSource: { include: { PaymentSourceConfig: true } } } },
				},
			},
			RemoteParticipants: { include: { HydraVerificationKey: true, Wallet: { select: { walletVkey: true } } } },
		},
	});
	const localWallet = head.LocalParticipant?.Wallet;
	if (!localWallet || localWallet.type !== HotWalletType.Purchasing) throw new Error('local wallet is not Purchasing');
	const localParticipant = head.LocalParticipant;
	if (!localParticipant) throw new Error('selected head has no local participant');
	const { httpUrl: nodeHttpUrl, wsUrl: nodeWsUrl } = validateHydraNodeUrls(
		localParticipant.nodeHttpUrl,
		localParticipant.nodeUrl,
		{
			plaintextHosts: getHydraPlaintextHosts(),
		},
	);
	if (!head.headIdentifier) throw new Error('selected head has no observed Hydra head identifier');
	const hydraNode = new HydraNode({
		httpUrl: nodeHttpUrl,
		wsUrl: nodeWsUrl,
		expectedHeadId: head.headIdentifier,
	});
	const rpcKey = localWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
	if (!rpcKey) throw new Error('no rpc provider key');
	if (head.RemoteParticipants.length !== 1)
		throw new Error('selected head does not have exactly one remote participant');
	const localHydraVerificationKey = deriveHydraVerificationKeyCborHex(decrypt(localParticipant.HydraSecretKey.hydraSK));
	const storedRemoteKey = head.RemoteParticipants[0]!.HydraVerificationKey.hydraVK;
	let remoteHydraVerificationKey: string;
	try {
		remoteHydraVerificationKey = normalizeHydraVerificationKeyCborHex(storedRemoteKey);
	} catch (plaintextError) {
		try {
			remoteHydraVerificationKey = normalizeHydraVerificationKeyCborHex(decrypt(storedRemoteKey));
		} catch {
			throw plaintextError;
		}
	}
	await verifyHydraHeadInitOnChain({
		observer: getBlockfrostInstance(Network.Preprod, rpcKey),
		headId: head.headIdentifier,
		expectedVerificationKeys: [localHydraVerificationKey, remoteHydraVerificationKey],
		expectedParticipantVkeys: [localWallet.walletVkey, head.RemoteParticipants[0]!.Wallet.walletVkey],
		contestationPeriodSeconds: head.contestationPeriod,
	});

	const pendingReconciliation = await reconcilePendingHydraCommit({
		id: localParticipant.id,
		hasCommitted: localParticipant.hasCommitted,
		commitTxHash: localParticipant.commitTxHash,
		commitInvalidHereafterSlot: localParticipant.commitInvalidHereafterSlot,
		network: Network.Preprod,
		rpcProviderApiKey: rpcKey,
	});
	if (pendingReconciliation === 'confirmed') throw new Error('local participant has already committed');
	if (pendingReconciliation !== 'none' && pendingReconciliation !== 'cleared') {
		throw new Error(`existing commit cannot be retried safely: ${pendingReconciliation}`);
	}

	const { wallet, utxos } = await generateWalletExtended(Network.Preprod, rpcKey, localWallet.Secret.encryptedMnemonic);
	if (!utxos.length) throw new Error('buyer wallet has no L1 UTxOs to commit');

	// Keep datum/reference-script outputs out of the commit. Leave every largest
	// plain UTxO untouched because hydra-node uses this same key for fee fuel and
	// may select any largest tie.
	const { commitUtxos, fuelUtxos, excludedUtxos } = selectCommitUtxosWithFuelReserve(utxos);
	if (!fuelUtxos.length) {
		throw new Error('buyer wallet has no plain (datum- and reference-script-free) L1 UTxO available for fee fuel');
	}
	if (!commitUtxos.length) {
		throw new Error(
			'buyer wallet needs a plain L1 UTxO strictly smaller than its largest UTxO so the largest can remain available for Hydra fee fuel',
		);
	}

	const map: Record<string, ReturnType<typeof mapUTxOToHydraUTxO>> = {};
	for (const utxo of commitUtxos) {
		map[`${utxo.input.txHash}#${utxo.input.outputIndex}`] = mapUTxOToHydraUTxO(utxo);
	}
	console.log(
		`committing ${commitUtxos.length} buyer UTxO(s), reserving ${fuelUtxos.length} largest fee UTxO(s), and excluding ${excludedUtxos.length} datum/reference-script UTxO(s) from ${localWallet.walletAddress.slice(0, 24)}…`,
	);

	const draft = getHydraTransaction(await hydraNode.post('/commit', map));
	if (!draft) throw new Error('/commit returned no valid transaction');
	const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(Network.Preprod));
	if (!slotConfig) throw new Error('Hydra L1 slot configuration is incomplete or invalid');
	const validatedDraft = validateHydraCommitDraft({
		draft,
		commitUtxos,
		fuelUtxos,
		walletUtxos: utxos,
		expectedHeadId: head.headIdentifier,
		depositScriptHash: resolveHydraDepositScriptHash(),
		slotConfig,
	});

	const signed = await wallet.signTx(draft.cborHex, true);
	assertHydraCommitSignedBody(signed, validatedDraft.txId);
	const commitTxHash = validatedDraft.txId;

	const interpreted = interpretCardanoTxSubmitResult(
		await reserveAndSubmitHydraCommit(
			{
				participantId: localParticipant.id,
				commitTxHash,
				invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
			},
			async () =>
				await hydraNode.post('/cardano-transaction', {
					type: 'Tx ConwayEra',
					description: '',
					cborHex: signed,
				}),
		),
	);
	if (!interpreted.ok) {
		throw new Error(`/cardano-transaction rejected commit: ${interpreted.reason}`);
	}
	const reconciliation = await reconcilePendingHydraCommit({
		id: localParticipant.id,
		hasCommitted: false,
		commitTxHash,
		commitInvalidHereafterSlot: validatedDraft.invalidHereafterSlot,
		network: Network.Preprod,
		rpcProviderApiKey: rpcKey,
	});
	console.log(JSON.stringify({ commitTxHash, submitted: true, reconciliation }, null, 2));
	await prisma.$disconnect();
	process.exit(0);
}

function getHydraTransaction(value: unknown): HydraTransaction | undefined {
	if (!value || typeof value !== 'object') return undefined;
	if (!('type' in value) || !('cborHex' in value) || !('description' in value)) return undefined;
	if (value.type !== HydraTransactionType.TxConwayEra && value.type !== HydraTransactionType.UnwitnessedTxConwayEra) {
		return undefined;
	}
	if (typeof value.cborHex !== 'string' || typeof value.description !== 'string') return undefined;
	if ('txId' in value && value.txId !== undefined && typeof value.txId !== 'string') return undefined;
	return {
		type: value.type,
		cborHex: value.cborHex,
		description: value.description,
		...('txId' in value && typeof value.txId === 'string' ? { txId: value.txId } : {}),
	};
}

main().catch(async (e) => {
	console.error(e);
	await prisma.$disconnect();
	process.exit(1);
});
