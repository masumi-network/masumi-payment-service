/* eslint-disable @typescript-eslint/no-explicit-any */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppContext } from "@/lib/contexts/AppContext";

type TransactionType = string;

type Transaction = {
  type: 'payment' | 'purchase';
  createdAt: string;
  updatedAt: string;
  status: string;
  txHash?: string;
  utxo?: string;
  errorType?: string;
  errorNote?: string;
  errorRequiresManualReview?: boolean;
  identifier: string;
  sellingWallet: any;
  collectionWallet: any;
  buyerWallet: any;
  amounts: any[];
  checkedBy: any;
}

type TransactionListProps = {
  contractAddress?: string;
  network?: string;
  paymentType?: string;
  contract?: any;
  walletAddress?: string;
}

const MAX_ID_LENGTH = 32;
const MAX_HASH_LENGTH = 16;

const shortenText = (text: string, maxLength: number) => {
  if (!text || text.length <= maxLength) return text;
  const start = Math.ceil(maxLength / 2);
  const end = Math.floor(maxLength / 2);
  return `${text.substring(0, start)}...${text.substring(text.length - end)}`;
};

const formatStatus = (status: string) => {
  if (status === 'PaymentRequested') return 'Payment Requested';
  if (status === 'PurchaseRequested') return 'Purchase Requested';
  return status;
};

export function TransactionList({ contractAddress: paymentContractAddress, network, paymentType }: TransactionListProps) {
  const { state } = useAppContext();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<TransactionType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  useEffect(() => {
    const fetchTransactions = async () => {
      setIsLoading(true);
      try {
        const queryParams = new URLSearchParams({
          ...(paymentContractAddress && { paymentContractAddress: paymentContractAddress }),
          ...(network && { network }),
          ...(paymentType && { paymentType }),
          limit: '100'
        }).toString();

        const responsePayment = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/payment?${queryParams}`, {
          headers: {
            'token': state.apiKey!
          }
        });
        if (!responsePayment.ok) {
          throw new Error('Failed to fetch transactions');
        }
        const responsePurchase = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/purchase?${queryParams}`, {
          headers: {
            'token': state.apiKey!
          }
        });
        if (!responsePurchase.ok) {
          throw new Error('Failed to fetch transactions');
        }

        const dataPayment = await responsePayment.json();
        const dataPurchase = await responsePurchase.json();
        const data = [...dataPayment?.data?.transactions, ...dataPurchase?.data?.transactions];
        setTransactions(data);
      } catch (error) {
        console.error('Failed to fetch transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };

    if (paymentContractAddress || network || paymentType) {
      fetchTransactions();
    }
  }, [paymentContractAddress, network, paymentType, state.apiKey]);
  const filteredTransactions = transactions.filter((tx: Transaction) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'payments' && tx.type === 'payment') ||
      (filter === 'purchases' && tx.type === 'purchase') ||
      (filter === 'errors' && tx.errorType);

    const searchTerm = searchQuery.toLowerCase();
    const matchesSearch =
      !searchQuery ||
      tx.identifier.toLowerCase().includes(searchTerm) ||
      tx.status.toLowerCase().includes(searchTerm) ||
      (tx.txHash && tx.txHash.toLowerCase().includes(searchTerm)) ||
      (tx.errorNote && tx.errorNote.toLowerCase().includes(searchTerm));

    return matchesFilter && matchesSearch;
  });

  const getStatusColor = (status: string, hasError?: boolean) => {
    if (hasError) return "text-destructive";
    switch (status.toLowerCase()) {
      case 'payment received':
      case 'completed':
        return "text-green-500";
      case 'processing':
      case 'waiting on output':
        return "text-yellow-500";
      case 'failed':
        return "text-destructive";
      default:
        return "text-muted-foreground";
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex flex-row items-center justify-between">
          <CardTitle>Transactions</CardTitle>
          <div className="flex gap-2">
            <Button
              variant={filter === 'all' ? "default" : "secondary"}
              onClick={() => setFilter('all')}
            >
              All
            </Button>
            <Button
              variant={filter === 'payments' ? "default" : "secondary"}
              onClick={() => setFilter('payments')}
            >
              Payments
            </Button>
            <Button
              variant={filter === 'purchases' ? "default" : "secondary"}
              onClick={() => setFilter('purchases')}
            >
              Purchases
            </Button>
            <Button
              variant={filter === 'errors' ? "default" : "secondary"}
              onClick={() => setFilter('errors')}
            >
              Errors
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search transactions by ID, status, txHash, error note..."
            className="pl-8"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-lg text-muted-foreground">Fetching transactions...</div>
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="text-sm text-muted-foreground">No transactions found.</div>
        ) : (
          <div className="rounded-md border">
            <div className="max-h-[600px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky top-0 bg-background">ID</TableHead>
                    <TableHead className="sticky top-0 bg-background">Type</TableHead>
                    <TableHead className="sticky top-0 bg-background">Status</TableHead>
                    <TableHead className="sticky top-0 bg-background">Amount</TableHead>
                    <TableHead className="sticky top-0 bg-background">Network</TableHead>
                    <TableHead className="sticky top-0 bg-background">Payment Type</TableHead>
                    <TableHead className="sticky top-0 bg-background min-w-[100px]">Tx Hash</TableHead>
                    <TableHead className="sticky top-0 bg-background">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTransactions.map((tx: any) => (
                    <TableRow
                      key={tx.identifier}
                      className={`cursor-pointer ${tx.errorType
                        ? 'bg-destructive/10 hover:bg-destructive/20'
                        : 'hover:bg-muted/50'
                        }`}
                      onClick={() => setSelectedTransaction(tx)}
                    >
                      <TableCell className="font-medium">
                        {shortenText(tx.identifier, MAX_ID_LENGTH)}
                      </TableCell>
                      <TableCell>{tx.type === 'payment' ? 'Payment' : 'Purchase'}</TableCell>
                      <TableCell className={getStatusColor(tx.status, !!tx.errorType)}>
                        {formatStatus(tx.status)}
                      </TableCell>
                      <TableCell>
                        {tx.amounts?.[0]?.amount
                          ? `${(tx.amounts[0].amount / 1000000).toFixed(2)} ₳`
                          : '-'}
                      </TableCell>
                      <TableCell>{tx.networkHandler?.network || tx.checkedBy?.network || '-'}</TableCell>
                      <TableCell>{tx.networkHandler?.paymentType || tx.checkedBy?.paymentType || '-'}</TableCell>
                      <TableCell className="min-w-[100px]">
                        {tx.txHash ? shortenText(tx.txHash, MAX_HASH_LENGTH) : '-'}
                      </TableCell>
                      <TableCell>{new Date(tx.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
      <Dialog open={!!selectedTransaction} onOpenChange={() => setSelectedTransaction(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Transaction Details</DialogTitle>
          </DialogHeader>
          {selectedTransaction && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="font-semibold mb-1">Transaction ID</h4>
                  <p className="text-sm font-mono">
                    {shortenText(selectedTransaction.identifier, MAX_ID_LENGTH)}
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold mb-1">Type</h4>
                  <p className="text-sm capitalize">{selectedTransaction.type}</p>
                </div>
                <div>
                  <h4 className="font-semibold mb-1">Created</h4>
                  <p className="text-sm">{new Date(selectedTransaction.createdAt).toLocaleString()}</p>
                </div>
                {selectedTransaction.createdAt !== selectedTransaction.updatedAt && (
                  <div>
                    <h4 className="font-semibold mb-1">Updated</h4>
                    <p className="text-sm">{new Date(selectedTransaction.updatedAt).toLocaleString()}</p>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <h4 className="font-semibold">Transaction Details</h4>
                <div className="grid grid-cols-2 gap-4 rounded-md border p-4">
                  <div>
                    <h5 className="text-sm font-medium mb-1">Status</h5>
                    <p className={`text-sm ${getStatusColor(selectedTransaction.status, !!selectedTransaction.errorType)}`}>
                      {formatStatus(selectedTransaction.status)}
                    </p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">Network</h5>
                    <p className="text-sm">{selectedTransaction.checkedBy?.network || '-'}</p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">Payment Type</h5>
                    <p className="text-sm">{selectedTransaction.checkedBy?.paymentType || '-'}</p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">Amount</h5>
                    <p className="text-sm">
                      {selectedTransaction.amounts?.[0]?.amount
                        ? `${(selectedTransaction.amounts[0].amount / 1000000).toFixed(2)} ₳`
                        : '-'}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <h5 className="text-sm font-medium mb-1">Transaction Hash</h5>
                    <p className="text-sm font-mono break-all">{selectedTransaction.txHash || '-'}</p>
                  </div>
                  {/* <div className="col-span-2">
                    <h5 className="text-sm font-medium mb-1">UTXO</h5>
                    <p className="text-sm font-mono break-all">{selectedTransaction.utxo || '-'}</p>
                  </div> */}
                </div>
              </div>

              {selectedTransaction.type === 'payment' && <div className="space-y-2">
                <h4 className="font-semibold">Wallet Information</h4>
                <div className="grid grid-cols-1 gap-4 rounded-md border p-4">
                  <div>
                    <h5 className="text-sm font-medium mb-1">Collection Wallet</h5>
                    <p className="text-sm font-mono break-all">
                      {selectedTransaction.collectionWallet?.walletAddress || '-'}
                    </p>
                    {selectedTransaction.collectionWallet?.note && (
                      <p className="text-sm text-muted-foreground mt-1">
                        Note: {selectedTransaction.collectionWallet.note}
                      </p>
                    )}
                  </div>
                </div>
              </div>}
              {selectedTransaction.errorType && (
                <div className="space-y-2">
                  <h4 className="font-semibold">Error Details</h4>
                  <div className="space-y-2 rounded-md bg-destructive/20 p-4">
                    <div className="space-y-1">
                      <p className="text-sm"><span className="font-medium">Error Type:</span> {selectedTransaction.errorType}</p>
                      {selectedTransaction.errorNote && (
                        <p className="text-sm"><span className="font-medium">Error Note:</span> {selectedTransaction.errorNote}</p>
                      )}
                      {selectedTransaction.errorRequiresManualReview && (
                        <p className="text-sm font-medium text-destructive mt-2">⚠️ This error requires manual review</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}