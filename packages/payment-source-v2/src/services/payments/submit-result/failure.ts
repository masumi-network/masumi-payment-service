import { makeHotWalletUnlocker, makePaymentRequestFailureMarker } from '../../request-failure';

/** Request-failure marker and hot-wallet unlocker shared by every submit-result path. */
export const markRequestFailed = makePaymentRequestFailureMarker({
	logMessage: 'Error submitting V2 result',
	errorNotePrefix: 'Submitting result failed: ',
	// Carry forward the seller-supplied result hash so operator forensics
	// preserve the originally-attempted submission. Without this the hash is
	// lost when the request parks in WaitingForManualAction.
	carryResultHash: true,
});

export const unlockHotWallet = makeHotWalletUnlocker('submit-result');
