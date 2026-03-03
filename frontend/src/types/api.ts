export interface BaseTransactionQuery {
  limit?: number;
  cursorIdentifier?: string;
  network?: string;
  paymentType?: string;
  contractAddress?: string;
}

export interface PaymentsQuery extends BaseTransactionQuery {}

export interface PurchasesQuery extends BaseTransactionQuery {
  sellingWalletVkey?: string;
}
