export interface BaseTransactionQuery {
  limit?: number;
  cursorIdentifier?: string;
  network?: string;
  paymentType?: string;
  contractAddress?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PaymentsQuery extends BaseTransactionQuery { }

export interface PurchasesQuery extends BaseTransactionQuery {
  sellingWalletVkey?: string;
} 