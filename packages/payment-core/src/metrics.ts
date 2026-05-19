import type {
	recordBusinessEndpointError as recordBusinessEndpointErrorFn,
	recordWalletLowBalanceAlert as recordWalletLowBalanceAlertFn,
} from '@/utils/metrics';
import * as metrics from '@/utils/metrics';

export const recordBusinessEndpointError: typeof recordBusinessEndpointErrorFn = (...args) =>
	metrics.recordBusinessEndpointError(...args);

export const recordWalletLowBalanceAlert: typeof recordWalletLowBalanceAlertFn = (...args) =>
	metrics.recordWalletLowBalanceAlert(...args);
