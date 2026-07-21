import { TransactionStatus } from '@/generated/prisma/client';
import { resolveEscrowSpendTransactionWrite } from './escrow-spend-transaction';

const WALLET_ID = 'wallet-1';
const ESCROW_TX_ID = 'escrow-tx';

describe('resolveEscrowSpendTransactionWrite', () => {
	it('creates a new pending row and archives the escrow row on the first attempt', () => {
		const write = resolveEscrowSpendTransactionWrite(
			{ id: ESCROW_TX_ID, txHash: 'abc123', status: TransactionStatus.Confirmed },
			WALLET_ID,
			ESCROW_TX_ID,
		);

		expect(write.CurrentTransaction).toHaveProperty('create');
		expect(write).toHaveProperty('TransactionHistory', { connect: { id: ESCROW_TX_ID } });
	});

	// The escrow row holds the only record of the UTxO being spent. Mutating it
	// is what wedged requests on 'Transaction hash not found'.
	it('never mutates the escrow row', () => {
		const write = resolveEscrowSpendTransactionWrite(
			{ id: ESCROW_TX_ID, txHash: 'abc123', status: TransactionStatus.Confirmed },
			WALLET_ID,
			ESCROW_TX_ID,
		);

		expect(write.CurrentTransaction).not.toHaveProperty('update');
	});

	it('reuses the pending row left by a previous retry instead of minting another', () => {
		const write = resolveEscrowSpendTransactionWrite(
			{ id: 'attempt-1-row', txHash: null, status: TransactionStatus.Pending },
			WALLET_ID,
			ESCROW_TX_ID,
		);

		expect(write.CurrentTransaction).toHaveProperty('update');
		expect(write.CurrentTransaction).not.toHaveProperty('create');
		// The escrow row was already archived by the first attempt.
		expect(write).not.toHaveProperty('TransactionHistory');
	});

	it('does not reuse a pending row that already carries a submitted hash', () => {
		const write = resolveEscrowSpendTransactionWrite(
			{ id: 'attempt-1-row', txHash: 'submitted', status: TransactionStatus.Pending },
			WALLET_ID,
			ESCROW_TX_ID,
		);

		expect(write.CurrentTransaction).toHaveProperty('create');
	});

	it('does not reuse a row that is no longer Pending', () => {
		const write = resolveEscrowSpendTransactionWrite(
			{ id: 'attempt-1-row', txHash: null, status: TransactionStatus.FailedViaTimeout },
			WALLET_ID,
			ESCROW_TX_ID,
		);

		expect(write.CurrentTransaction).toHaveProperty('create');
	});

	it('creates when there is no current transaction at all', () => {
		const write = resolveEscrowSpendTransactionWrite(null, WALLET_ID, ESCROW_TX_ID);

		expect(write.CurrentTransaction).toHaveProperty('create');
	});
});
