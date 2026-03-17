import { errorToString } from '@/utils/converter/error-string-convert';

interface ErrorPattern {
	test: (msg: string) => boolean;
	hint: string;
}

const BLOCKCHAIN_ERROR_PATTERNS: ErrorPattern[] = [
	{
		test: (msg) => msg.includes('utxo fully depleted'),
		hint: 'The wallet has no UTxOs available to cover this transaction. Ensure the wallet has sufficient ADA and UTxOs before retrying.',
	},
	{
		test: (msg) =>
			msg.includes('insufficient balance') || msg.includes('not enough ada') || msg.includes('not enough lovelace'),
		hint: 'The wallet balance is insufficient to complete this transaction. Top up the wallet with ADA and retry.',
	},
	{
		test: (msg) => msg.includes('exbudget') || msg.includes('exceededmemorylimit') || msg.includes('exceededsteplimit'),
		hint: 'Transaction execution units were exceeded. The script computation cost is too high; contact support if this persists.',
	},
	{
		test: (msg) => msg.includes('badinputsutxo') || msg.includes('bad inputs'),
		hint: 'A referenced UTxO has already been spent. Another transaction may have consumed it; wait for chain sync and retry.',
	},
	{
		test: (msg) => msg.includes('valuenotconserved'),
		hint: 'Transaction inputs and outputs do not balance. This is typically a fee or change calculation issue; retry or contact support.',
	},
	{
		test: (msg) => msg.includes('feetoosmall') || (msg.includes('fee') && msg.includes('too small')),
		hint: 'The transaction fee is below the network minimum. Retry with an updated fee estimate.',
	},
	{
		test: (msg) => msg.includes('outputtoosmall') || msg.includes('minimum ada') || msg.includes('min ada'),
		hint: 'A transaction output does not meet the minimum ADA requirement. Add more ADA to the output.',
	},
	{
		test: (msg) => msg.includes('alreadyinledger') || msg.includes('already submitted'),
		hint: 'This transaction has already been submitted to the chain. No action needed; wait for confirmation.',
	},
	{
		test: (msg) => msg.includes('timeout') && !msg.includes('mutex'),
		hint: 'The blockchain request timed out. The network may be congested; retry after a short delay.',
	},
	{
		test: (msg) =>
			msg.includes('status 402') || msg.includes('"status_code":402') || msg.includes('project plan limit'),
		hint: 'The Blockfrost project plan limit has been exceeded. Upgrade the plan or wait for the quota reset.',
	},
	{
		test: (msg) => msg.includes('status 403') || msg.includes('"status_code":403') || msg.includes('not authorized'),
		hint: 'Blockfrost returned 403 Forbidden. Verify the API key is correct and configured for the right network (mainnet vs preprod).',
	},
	{
		test: (msg) => msg.includes('status 404') || msg.includes('"status_code":404'),
		hint: 'The requested resource was not found on chain (Blockfrost 404). The UTxO or transaction may already be spent or not yet propagated.',
	},
	{
		test: (msg) => msg.includes('status 418') || msg.includes('"status_code":418'),
		hint: 'This IP address has been banned by Blockfrost. Contact Blockfrost support to unblock it.',
	},
	{
		test: (msg) =>
			msg.includes('status 429') ||
			msg.includes('"status_code":429') ||
			msg.includes('too many requests') ||
			msg.includes('rate limit'),
		hint: 'Blockfrost rate limit reached. Reduce request frequency or upgrade the Blockfrost plan.',
	},
	{
		test: (msg) => msg.includes('status 500') || msg.includes('"status_code":500') || msg.includes('server error'),
		hint: 'Blockfrost returned a 500 server error. This is a temporary upstream issue; retry after a short delay.',
	},
	{
		test: (msg) => msg.includes('no utxos found') || msg.includes('wallet is empty'),
		hint: 'The wallet contains no UTxOs. Fund the wallet with ADA before retrying.',
	},
	{
		test: (msg) => msg.includes('collateral utxo not found'),
		hint: 'No suitable collateral UTxO was found. Ensure the wallet has a pure-ADA UTxO of at least 5 ADA.',
	},
	{
		test: (msg) => msg.includes('utxo not found'),
		hint: 'The specific UTxO was not found on chain. It may have been spent or the chain may not have synced yet.',
	},
	{
		test: (msg) => msg.includes('no datum found'),
		hint: 'The UTxO does not contain the expected inline datum. The contract state may have changed.',
	},
	{
		test: (msg) => msg.includes('mutex') || msg.includes('tryacquire'),
		hint: 'A concurrency lock could not be acquired. Another operation is likely running; the service will retry automatically.',
	},
];

export function interpretBlockchainError(error: unknown): string {
	const rawMessage = errorToString(error);
	if (rawMessage.includes('. Hint:')) {
		return rawMessage;
	}
	const lower = rawMessage.toLowerCase();
	for (const pattern of BLOCKCHAIN_ERROR_PATTERNS) {
		if (pattern.test(lower)) {
			return `${rawMessage}. Hint: ${pattern.hint}`;
		}
	}
	return rawMessage;
}
