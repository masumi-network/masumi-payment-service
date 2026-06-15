import { evaluateX402LowBalanceRules } from '@masumi/payment-source-x402';
import { logger } from '@masumi/payment-core/logger';
import { webhookEventsService } from '@/services/webhooks/events.service';

/**
 * Scheduled cycle for x402 managed-wallet low-balance monitoring. The package evaluates
 * every enabled rule against live on-chain balances and returns the rules that just
 * transitioned into Low; here we fan those out to the shared webhook system as
 * X402_WALLET_LOW_BALANCE events. Kept app-side so the payment-source package stays free
 * of webhook/app dependencies.
 */
export async function runX402LowBalanceMonitoringCycle(): Promise<void> {
	const alerts = await evaluateX402LowBalanceRules();
	if (alerts.length === 0) return;
	logger.info('x402 low-balance monitoring raised alerts', { count: alerts.length });
	for (const alert of alerts) {
		await webhookEventsService.triggerX402WalletLowBalance({
			ruleId: alert.ruleId,
			evmWalletId: alert.evmWalletId,
			walletAddress: alert.walletAddress,
			walletType: alert.walletType,
			caip2Network: alert.caip2Network,
			asset: alert.asset,
			thresholdAmount: alert.thresholdAmount,
			currentAmount: alert.currentAmount,
			checkedAt: alert.checkedAt,
		});
	}
}
