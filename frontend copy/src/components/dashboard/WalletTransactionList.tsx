import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useState, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { useAppContext } from "@/lib/contexts/AppContext";

type WalletTransactionListProps = {
  walletAddress: string;
}

export function WalletTransactionList({ walletAddress }: WalletTransactionListProps) {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const { state } = useAppContext();

  const fetchTransactions = async (cursorId?: string) => {
    setIsLoading(true);
    try {
      const queryParams = new URLSearchParams({
        walletAddress,
        limit: '10',
        ...(cursorId && { cursor: cursorId })
      }).toString();

      const response = await fetch(`/api/wallet-transactions?${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${state.apiKey}`
        }
      });

      if (!response.ok) throw new Error('Failed to fetch wallet transactions');
      
      const data = await response.json();
      const newTransactions = data?.transactions || [];
      
      setTransactions(cursorId ? [...transactions, ...newTransactions] : newTransactions);
      setHasMore(newTransactions.length === 10);
      setCursor(newTransactions[newTransactions.length - 1]?.id || null);
    } catch (error) {
      console.error('Failed to fetch wallet transactions:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (walletAddress) {
      fetchTransactions();
    }
  }, [walletAddress]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Wallet Transactions</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && transactions.length === 0 ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-[250px]" />
            <Skeleton className="h-4 w-[200px]" />
            <Skeleton className="h-4 w-[300px]" />
          </div>
        ) : (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transaction Hash</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No transactions found
                      </TableCell>
                    </TableRow>
                  ) : (
                    transactions.map((tx) => (
                      <TableRow key={tx.id}>
                        <TableCell className="font-mono">{tx.hash}</TableCell>
                        <TableCell>{tx.type}</TableCell>
                        <TableCell>{tx.amount}</TableCell>
                        <TableCell>{new Date(tx.date).toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <Pagination
              hasMore={hasMore}
              isLoading={isLoading}
              onLoadMore={() => cursor && fetchTransactions(cursor)}
              className="mt-4"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
} 