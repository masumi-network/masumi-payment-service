import { OnChainState, TransactionStatus } from '@prisma/client';

interface TransactionWithFees {
  fees: bigint | null;
  status: TransactionStatus;
  previousOnChainState: OnChainState | null;
  newOnChainState: OnChainState | null;
}

interface FeeCalculationResult {
  totalBuyerFees: string;
  totalSellerFees: string;
}

const LOVELACE_PER_ADA = 1_000_000;
function lovelaceToAda(lovelace: bigint): string {
  const ada = Number(lovelace) / LOVELACE_PER_ADA;
  return ada.toFixed(6);
}
export function calculateTransactionFees(
  currentTransaction: TransactionWithFees | null,
  transactionHistory: TransactionWithFees[],
): FeeCalculationResult {
  const allTransactions = [
    ...(currentTransaction ? [currentTransaction] : []),
    ...transactionHistory,
  ];

  const confirmedTransactions = allTransactions.filter(
    (tx) =>
      tx.status === TransactionStatus.Confirmed &&
      tx.fees !== null &&
      tx.newOnChainState !== null,
  );

  let buyerFeesTotal = BigInt(0);
  let sellerFeesTotal = BigInt(0);

  for (const tx of confirmedTransactions) {
    const fee = tx.fees!;
    const from = tx.previousOnChainState;
    const to = tx.newOnChainState!;

    if (isBuyerTransaction(from, to)) {
      buyerFeesTotal += fee;
    } else if (isSellerTransaction(from, to)) {
      sellerFeesTotal += fee;
    }
  }

  return {
    totalBuyerFees: lovelaceToAda(buyerFeesTotal),
    totalSellerFees: lovelaceToAda(sellerFeesTotal),
  };
}
function isBuyerTransaction(
  from: OnChainState | null,
  to: OnChainState,
): boolean {
  // Initial lock - buyer locks funds in contract
  if (from === null && to === OnChainState.FundsLocked) return true;

  // Buyer requests refund
  if (from === OnChainState.FundsLocked && to === OnChainState.RefundRequested)
    return true;
  if (from === OnChainState.ResultSubmitted && to === OnChainState.Disputed)
    return true;

  // Buyer cancels refund request
  if (from === OnChainState.RefundRequested && to === OnChainState.FundsLocked)
    return true;
  if (from === OnChainState.Disputed && to === OnChainState.ResultSubmitted)
    return true;

  // Buyer withdraws refund
  if (
    from === OnChainState.RefundRequested &&
    to === OnChainState.RefundWithdrawn
  )
    return true;
  if (from === OnChainState.FundsLocked && to === OnChainState.RefundWithdrawn)
    return true;

  return false;
}
function isSellerTransaction(
  from: OnChainState | null,
  to: OnChainState,
): boolean {
  if (from === OnChainState.FundsLocked && to === OnChainState.ResultSubmitted)
    return true;
  if (
    from === OnChainState.ResultSubmitted &&
    to === OnChainState.ResultSubmitted
  )
    return true;
  if (
    from === OnChainState.RefundRequested &&
    to === OnChainState.ResultSubmitted
  )
    return true;
  if (from === OnChainState.Disputed && to === OnChainState.Disputed)
    return true;

  // Seller withdraws funds
  if (from === OnChainState.ResultSubmitted && to === OnChainState.Withdrawn)
    return true;

  // Seller authorizes refund
  if (from === OnChainState.Disputed && to === OnChainState.RefundRequested)
    return true;

  // Admin disputed withdrawal - NOT counted for seller
  if (from === OnChainState.Disputed && to === OnChainState.DisputedWithdrawn)
    return false;

  // Invalid state - NOT counted for seller
  if (to === OnChainState.FundsOrDatumInvalid) return false;

  // Default unknown transitions to seller (conservative approach)
  return true;
}
