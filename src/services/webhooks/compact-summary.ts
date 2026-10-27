/**
 * The one-message summary sent to chat formats (Slack, Google Chat, Discord).
 *
 * Extended endpoints get the full payload instead; this renders only what an
 * operator reads in a channel.
 */
import { WebhookEventType } from '@/generated/prisma/client';
import { WEBHOOK_TEST_EVENT_TYPE } from '@/types/webhook-constants';
import type { WebhookSendPayload } from '@/types/webhook-payloads';
import { getWebhookEventPresentation } from './event-presentation';

const MAX_SUMMARY_TX_IDS = 5;
/** A node reason can run to 2000 characters, and Discord refuses a message longer than that. */
const MAX_SUMMARY_REASON_LENGTH = 500;
const LOVELACE_DECIMALS = 1_000_000n;
const MAINNET_USDCX_UNIT = '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378';
const MAINNET_USDM_UNIT = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
const PREPROD_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

export function buildCompactSummary(payload: WebhookSendPayload): string {
	const eventPresentation = getWebhookEventPresentation(payload.event_type);
	const lines = [`${eventPresentation.emoji} ${eventPresentation.title}`];
	if (payload.service_name) {
		lines.push(`🛰️ Service: ${payload.service_name}`);
	}

	if (payload.event_type === WEBHOOK_TEST_EVENT_TYPE) {
		lines.push('');
		appendDetailLine(lines, '💬', 'Message', payload.data.message);
		appendDetailLine(lines, '🔔', 'Webhook', payload.data.webhookName);
		appendDetailLine(lines, '🏦', 'Payment source', payload.data.paymentSourceId);
		appendDetailLine(lines, '🕒', 'Sent at', payload.timestamp);
		return lines.join('\n');
	}

	if (payload.event_type === WebhookEventType.WALLET_LOW_BALANCE) {
		lines.push('');
		appendDetailLine(lines, '👛', 'Wallet ID', payload.data.walletId);
		appendDetailLine(lines, '📬', 'Wallet address', payload.data.walletAddress);
		appendDetailLine(lines, '🏦', 'Payment source', payload.data.paymentSourceId);
		appendDetailLine(lines, '🌐', 'Network', payload.data.network);
		appendDetailLine(
			lines,
			'🎯',
			'Threshold',
			formatBalanceForDisplay(payload.data.thresholdAmount, payload.data.assetUnit),
		);
		appendDetailLine(
			lines,
			'💰',
			'New balance',
			formatBalanceForDisplay(payload.data.currentAmount, payload.data.assetUnit),
		);
		appendDetailLine(lines, '🕒', 'Checked at', payload.data.checkedAt);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (
		payload.event_type === WebhookEventType.FUND_DISTRIBUTION_SENT ||
		payload.event_type === WebhookEventType.FUND_DISTRIBUTION_CONFIRMED ||
		payload.event_type === WebhookEventType.FUND_DISTRIBUTION_FAILED
	) {
		lines.push('');
		appendDetailLine(lines, '🏦', 'Fund Wallet ID', payload.data.fundWalletId);
		appendDetailLine(lines, '📬', 'Fund Wallet address', payload.data.fundWalletAddress);
		appendDetailLine(lines, '🔗', 'Tx hash', payload.data.txHash ?? 'not submitted');
		appendDetailLine(lines, '🌐', 'Network', payload.data.network);
		appendDetailLine(lines, '📦', 'Recipients', String(payload.data.distributions.length));
		if (payload.event_type === WebhookEventType.FUND_DISTRIBUTION_FAILED) {
			appendDetailLine(lines, '❌', 'Error', payload.data.error);
		}
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (
		payload.event_type === WebhookEventType.X402_PAYMENT_SETTLED ||
		payload.event_type === WebhookEventType.X402_PAYMENT_FAILED
	) {
		lines.push('');
		appendDetailLine(lines, '🏷️', 'Attempt ID', payload.data.attemptId);
		appendDetailLine(lines, '🌐', 'Network', payload.data.caip2Network);
		appendDetailLine(lines, '🪙', 'Asset', payload.data.asset);
		appendDetailLine(lines, '💰', 'Amount', payload.data.amount);
		appendDetailLine(lines, '📬', 'Pay to', payload.data.payTo);
		appendDetailLine(lines, '👛', 'Payer', payload.data.payer);
		appendDetailLine(lines, '🔗', 'Tx hash', payload.data.txHash);
		appendDetailLine(lines, '⚠️', 'Error', payload.data.errorMessage);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (payload.event_type === WebhookEventType.X402_WALLET_LOW_BALANCE) {
		lines.push('');
		appendDetailLine(lines, '👛', 'Wallet ID', payload.data.evmWalletId);
		appendDetailLine(lines, '📬', 'Wallet address', payload.data.walletAddress);
		appendDetailLine(lines, '🧭', 'Direction', payload.data.walletType);
		appendDetailLine(lines, '🌐', 'Network', payload.data.caip2Network);
		appendDetailLine(lines, '🪙', 'Asset', payload.data.asset);
		appendDetailLine(lines, '🎯', 'Threshold', payload.data.thresholdAmount);
		appendDetailLine(lines, '💰', 'New balance', payload.data.currentAmount);
		appendDetailLine(lines, '🕒', 'Checked at', payload.data.checkedAt);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (payload.event_type === WebhookEventType.HYDRA_HEAD_LOW_BALANCE) {
		lines.push('');
		appendDetailLine(lines, '🧑‍🤝‍🧑', 'Participant', payload.data.hydraLocalParticipantId);
		appendDetailLine(lines, '🌊', 'Hydra head', payload.data.hydraHeadId);
		appendDetailLine(lines, '🪙', 'Asset', payload.data.assetUnit);
		appendDetailLine(lines, '🎯', 'Threshold', payload.data.thresholdAmount);
		appendDetailLine(lines, '💰', 'Spendable in-head balance', payload.data.currentAmount);
		appendDetailLine(lines, '🕒', 'Checked at', payload.data.checkedAt);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (payload.event_type === WebhookEventType.HYDRA_HEAD_SNAPSHOT_ROUND_STUCK) {
		lines.push('');
		appendDetailLine(lines, '🌊', 'Hydra head', payload.data.hydraHeadId);
		appendDetailLine(lines, '🏷️', 'Round', payload.data.roundTag);
		appendDetailLine(lines, '🔢', 'Snapshot', payload.data.snapshotNumber?.toString());
		appendDetailLine(lines, '✍️', 'Signatures', payload.data.signatoryCount.toString());
		appendDetailLine(lines, '🧾', 'Transactions', summarizeTxIds(payload.data.txIds));
		appendDetailLine(lines, '🕒', 'Stuck since', payload.data.stuckSince);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (payload.event_type === WebhookEventType.HYDRA_HEAD_POST_TX_FAILED) {
		lines.push('');
		appendDetailLine(lines, '🌊', 'Hydra head', payload.data.hydraHeadId);
		appendDetailLine(lines, '📍', 'Head status', payload.data.headStatus);
		appendDetailLine(lines, '🧾', 'Transaction', payload.data.postChainTxTag);
		appendDetailLine(lines, '📝', 'Reason', payload.data.reason.slice(0, MAX_SUMMARY_REASON_LENGTH));
		appendDetailLine(lines, '🕒', 'Failed at', payload.data.failedAt);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (payload.event_type === WebhookEventType.HYDRA_HEAD_CONTEST_MISSING) {
		lines.push('');
		appendDetailLine(lines, '🌊', 'Hydra head', payload.data.hydraHeadId);
		appendDetailLine(lines, '📍', 'Head status', payload.data.headStatus);
		appendDetailLine(lines, '⛓️', 'Snapshot on chain', String(payload.data.closedSnapshotNumber));
		appendDetailLine(lines, '✍️', 'Snapshot signed', String(payload.data.verifiedSnapshotNumber));
		appendDetailLine(lines, '🕒', 'Gap since', payload.data.gapSince);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	if (payload.event_type === WebhookEventType.HYDRA_HEAD_CONTEST_WATCH_ALERT) {
		lines.push('');
		appendDetailLine(lines, '🌊', 'Hydra head', payload.data.hydraHeadId);
		appendDetailLine(lines, '⚠️', 'Reason', payload.data.reason);
		appendDetailLine(lines, '📍', 'Head status', payload.data.headStatus);
		if (payload.data.chainState) appendDetailLine(lines, '⛓️', 'L1 state', payload.data.chainState);
		if (payload.data.chainTxHash) appendDetailLine(lines, '🧾', 'L1 transaction', payload.data.chainTxHash);
		if (payload.data.unavailableSince)
			appendDetailLine(lines, '🕒', 'Unavailable since', payload.data.unavailableSince);
		appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
		return lines.join('\n');
	}

	lines.push('');
	appendDetailLine(lines, '🏷️', 'ID', payload.data.id);
	appendDetailLine(lines, '⛓️', 'Blockchain ID', payload.data.blockchainIdentifier);
	appendDetailLine(lines, '🏦', 'Payment source', payload.data.PaymentSource.id);
	appendDetailLine(lines, '🌐', 'Network', payload.data.PaymentSource.network);
	appendDetailLine(lines, '📍', 'On-chain state', payload.data.onChainState);
	appendDetailLine(lines, '➡️', 'Next action', payload.data.NextAction.requestedAction);
	appendDetailLine(lines, '⚠️', 'Error type', payload.data.NextAction.errorType);
	appendDetailLine(lines, '📝', 'Error note', payload.data.NextAction.errorNote);
	appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);

	return lines.join('\n');
}

/** A round can name thousands of transactions; the summary line shows a few and a count. */
function summarizeTxIds(txIds: string[]): string | null {
	if (txIds.length === 0) return null;
	const shown = txIds.slice(0, MAX_SUMMARY_TX_IDS).join(', ');
	const hidden = txIds.length - MAX_SUMMARY_TX_IDS;
	return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}

function appendDetailLine(lines: string[], emoji: string, label: string, value: string | null | undefined): void {
	if (value == null || value === '') {
		return;
	}

	lines.push(`${emoji} ${label}: ${value}`);
}

function formatBalanceForDisplay(rawAmount: string, assetUnit: string): string {
	const assetLabel = getAssetLabel(assetUnit);
	if (!usesSixDecimals(assetUnit)) {
		return `${rawAmount} ${assetLabel}`;
	}

	return `${formatSixDecimalAmount(rawAmount)} ${assetLabel}`;
}

function usesSixDecimals(assetUnit: string): boolean {
	return (
		assetUnit === 'lovelace' ||
		assetUnit === MAINNET_USDCX_UNIT ||
		assetUnit === MAINNET_USDM_UNIT ||
		assetUnit === PREPROD_USDM_UNIT
	);
}

function getAssetLabel(assetUnit: string): string {
	switch (assetUnit) {
		case '':
		case 'lovelace':
			return 'ADA';
		case MAINNET_USDCX_UNIT:
			return 'USDCx';
		case MAINNET_USDM_UNIT:
			return 'USDM';
		case PREPROD_USDM_UNIT:
			return 'tUSDM';
		default:
			return decodeAssetName(assetUnit) ?? assetUnit;
	}
}

function decodeAssetName(assetUnit: string): string | null {
	if (assetUnit.length <= 56) {
		return null;
	}

	const assetNameHex = assetUnit.slice(56);
	if (assetNameHex.length === 0 || assetNameHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(assetNameHex)) {
		return null;
	}

	try {
		const decoded = Buffer.from(assetNameHex, 'hex').toString('utf8').replace(/\0/g, '').trim();
		if (decoded.length === 0) {
			return null;
		}

		return /^[\x20-\x7E]+$/.test(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

function formatSixDecimalAmount(rawAmount: string): string {
	const amount = BigInt(rawAmount);
	const whole = amount / LOVELACE_DECIMALS;
	const fraction = (amount % LOVELACE_DECIMALS).toString().padStart(6, '0').replace(/0+$/, '');

	return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}
