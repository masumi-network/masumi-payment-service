import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { deserializeDatum } from '@meshsdk/core';
import { prisma } from '@masumi/payment-core/db';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import {
	HydraHeadStatus,
	OnChainState,
	PaymentSourceType,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import {
	headParticipantsMatch,
	validateCanonicalInitialLock,
} from '@/services/hydra-connection-manager/hydra-datum-guards';
import {
	hydraValidityUpperBoundTimeMs,
	parseHydraTransactionEvidence,
} from '@/services/hydra-connection-manager/hydra-transaction-evidence';
import { serializeCardanoTransactionOutput } from '@/lib/hydra/hydra/snapshot-verification';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { datumMatchesRequest } from '@/utils/logic/l2-datum-validation';
import { RepairValidationError, type RepairTargetKind } from './index';

const include = {
	CurrentTransaction: true,
	PaymentSource: true,
	SmartContractWallet: true,
} as const;

/** Revalidate an existing rejected lock. Never construct or submit a transaction. */
export async function validateHydraRepair(params: { kind: RepairTargetKind; requestId: string; txHash: string }) {
	const request =
		params.kind === 'purchase'
			? await prisma.purchaseRequest.findUnique({
					where: { id: params.requestId },
					include: { ...include, PaidFunds: true, SellerWallet: true },
				})
			: await prisma.paymentRequest.findUnique({
					where: { id: params.requestId },
					include: { ...include, RequestedFunds: true, BuyerWallet: true },
				});
	const fail = (message: string): never => {
		throw new RepairValidationError(message);
	};
	if (!request) return fail('Hydra repair request was not found');
	const current = request.CurrentTransaction;
	if (
		request.onChainState !== OnChainState.FundsOrDatumInvalid ||
		request.layer !== TransactionLayer.L2 ||
		request.PaymentSource.paymentSourceType !== PaymentSourceType.Web3CardanoV2 ||
		!current ||
		current.layer !== TransactionLayer.L2 ||
		current.status !== TransactionStatus.Confirmed ||
		!current.hydraHeadId ||
		current.txHash !== params.txHash ||
		request.currentHydraUtxoTxHash !== params.txHash ||
		request.currentHydraUtxoOutputIndex == null
	) {
		return fail('Hydra repair requires the exact current confirmed L2 output of a rejected lock');
	}
	const headId = current.hydraHeadId;
	const manager = getHydraConnectionManager();
	await manager.flushHeadStatus(headId);
	const head = await prisma.hydraHead.findUnique({
		where: { id: headId },
		include: { HydraRelation: { include: { LocalHotWallet: true, RemoteWallet: true } } },
	});
	if (
		!head ||
		!head.isEnabled ||
		head.isClosing ||
		!head.initTxHash ||
		!head.headIdentifier ||
		head.reconciliationCompletedAt != null ||
		head.status !== HydraHeadStatus.Open
	) {
		return fail('Hydra head is not open for verified repair');
	}
	const node = manager.getNode(headId);
	if (!node || !node.hasVerifiedPinnedSessions || !node.confirmedTransactionHistoryReady)
		return fail('Verified Hydra history is unavailable');
	const outputIndex = request.currentHydraUtxoOutputIndex;
	const reference = `${params.txHash}#${outputIndex}`;
	const currentOutput = node.getVerifiedCurrentOutput(reference, head.latestSnapshotNumber);
	const confirmed = node.getConfirmedTransaction(params.txHash);
	if (!currentOutput || !confirmed)
		return fail('Current unspent Hydra output or its confirmed transaction evidence is unavailable');
	const evidence = parseHydraTransactionEvidence(confirmed.cborHex);
	const output = evidence?.outputs.find((entry) => entry.outputIndex === outputIndex);
	if (
		!evidence ||
		evidence.txHash !== params.txHash ||
		!output?.plutusData ||
		output.address !== request.PaymentSource.smartContractAddress
	)
		return fail('Hydra output does not match its confirmed transaction');
	const transaction = FixedTransaction.from_hex(confirmed.cborHex);
	if (
		!transaction.is_valid() ||
		serializeCardanoTransactionOutput(transaction.body().outputs().get(outputIndex)) !== currentOutput
	)
		return fail('Hydra snapshot output differs from the confirmed transaction');
	const network = convertNetwork(request.PaymentSource.network);
	const decoded = decodeV2ContractDatum(deserializeDatum(output.plutusData), network, output.address);
	if (
		!decoded ||
		decoded.blockchainIdentifier !== request.blockchainIdentifier ||
		decoded.state !== SmartContractState.FundsLocked
	)
		return fail("Hydra output is not this request's initial lock");
	const matchingOutputs = evidence.outputs.filter((entry) => {
		if (entry.address !== output.address || !entry.plutusData) return false;
		try {
			return (
				decodeV2ContractDatum(deserializeDatum(entry.plutusData), network, entry.address)?.blockchainIdentifier ===
				request.blockchainIdentifier
			);
		} catch {
			return false;
		}
	});
	if (matchingOutputs.length !== 1) return fail('Hydra repair target is ambiguous');
	const amounts = 'PaidFunds' in request ? request.PaidFunds : request.RequestedFunds;
	const buyerWallet = 'BuyerWallet' in request ? request.BuyerWallet : request.SmartContractWallet;
	const sellerWallet = 'SellerWallet' in request ? request.SellerWallet : request.SmartContractWallet;
	const datumMatches = datumMatchesRequest(decoded, {
		inputHash: request.inputHash,
		payByTime: request.payByTime,
		submitResultTime: request.submitResultTime,
		unlockTime: request.unlockTime,
		externalDisputeUnlockTime: request.externalDisputeUnlockTime,
		buyerReturnAddress: request.buyerReturnAddress,
		sellerReturnAddress: request.sellerReturnAddress,
		buyerVkey: buyerWallet?.walletVkey ?? null,
		buyerAddress: buyerWallet?.walletAddress ?? null,
		sellerVkey: sellerWallet?.walletVkey ?? null,
		sellerAddress: sellerWallet?.walletAddress ?? null,
	});
	if (
		!datumMatches ||
		request.collateralReturnLovelace !== decoded.collateralReturnLovelace ||
		!headParticipantsMatch(decoded, params.kind, head, request.paymentSourceId)
	)
		return fail('Hydra repair datum does not match the request or head participants');
	if (!evidence.requiredSignerVkeys.includes(decoded.buyerVkey) || !evidence.signerVkeys.includes(decoded.buyerVkey))
		return fail("Hydra lock lacks the buyer's body-bound signature");
	const upper = hydraValidityUpperBoundTimeMs(evidence, resolveHydraL2EvidenceSlotConfig(network));
	if (
		upper == null ||
		upper > decoded.payByTime ||
		confirmed.confirmedAtMs == null ||
		!Number.isSafeInteger(confirmed.confirmedAtMs)
	)
		return fail('Hydra lock lacks safe deadline evidence');
	const validation = validateCanonicalInitialLock(decoded, amounts, output.amount, confirmed.confirmedAtMs);
	if (!validation.valid) return fail(validation.errorNote ?? 'Hydra lock validation failed');
	const assertFresh = () => {
		if (
			manager.getNode(headId) !== node ||
			!node.confirmedTransactionHistoryReady ||
			node.getVerifiedCurrentOutput(reference, head.latestSnapshotNumber) !== currentOutput
		)
			fail('Hydra repair evidence changed; preview again');
	};
	assertFresh();
	return {
		txHash: params.txHash,
		outputIndex,
		derivedOnChainState: OnChainState.FundsLocked,
		resultHash: null,
		headId,
		currentHydraUtxoRef: { txHash: params.txHash, outputIndex },
		currentTransactionId: current.id,
		requestUpdatedAt: request.updatedAt,
		ownerEpoch: head.ownerEpoch,
		snapshotNumber: head.latestSnapshotNumber,
		outputAmounts: output.amount,
		buyerWallet: { walletVkey: decoded.buyerVkey, walletAddress: decoded.buyerAddress },
		assertFresh,
	};
}
