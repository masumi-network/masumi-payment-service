import { shouldRetryWithoutOptionalWalletSplitter } from '../batch-interaction';

describe('shouldRetryWithoutOptionalWalletSplitter', () => {
	it('retries single-fee-UTxO batches when Mesh reports the optional splitter depleted inputs', () => {
		expect(
			shouldRetryWithoutOptionalWalletSplitter({
				walletUtxoCount: 1,
				includeWalletSplitter: true,
				error: new Error('UTxO Fully Depleted'),
			}),
		).toBe(true);
	});

	it('matches Mesh InputSelectionError objects from the Cardano SDK', () => {
		const error = Object.assign(new Error('UTxO Fully Depleted'), { name: 'InputSelectionError' });
		expect(
			shouldRetryWithoutOptionalWalletSplitter({
				walletUtxoCount: 1,
				includeWalletSplitter: true,
				error,
			}),
		).toBe(true);
	});

	it('does not retry when the wallet has multiple fee UTxOs', () => {
		expect(
			shouldRetryWithoutOptionalWalletSplitter({
				walletUtxoCount: 2,
				includeWalletSplitter: true,
				error: new Error('UTxO Fully Depleted'),
			}),
		).toBe(false);
	});

	it('does not retry unrelated batch build failures', () => {
		expect(
			shouldRetryWithoutOptionalWalletSplitter({
				walletUtxoCount: 1,
				includeWalletSplitter: true,
				error: new Error('evaluateTx did not return a SPEND budget'),
			}),
		).toBe(false);
	});

	it('does not retry once the splitter has already been disabled', () => {
		expect(
			shouldRetryWithoutOptionalWalletSplitter({
				walletUtxoCount: 1,
				includeWalletSplitter: false,
				error: new Error('UTxO Fully Depleted'),
			}),
		).toBe(false);
	});
});
