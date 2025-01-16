import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Transaction {
  id: string;
  contract: string;
  date: string;
  type: string;
  status: string;
  agent: string;
}

interface WalletTransactionsProps {
  transactions: Transaction[];
  onLoadMore: () => void;
}

export function WalletTransactions({ transactions, onLoadMore }: WalletTransactionsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transactions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {transactions.map((tx) => (
          <Card key={`${tx.id}-${tx.date}`} className="border border-border">
            <CardContent className="pt-6 space-y-2">
              <div className="text-sm">Transaction ID: {tx.id}</div>
              <div className="text-sm">Contract: {tx.contract}</div>
              <div className="text-sm">Date: {tx.date}</div>
              <div className="text-sm">Type: {tx.type}</div>
              <div className="text-sm">Status: {tx.status}</div>
              <div className="text-sm">Agent: {tx.agent}</div>
            </CardContent>
          </Card>
        ))}
        <Button variant="secondary" onClick={onLoadMore}>Load more</Button>
      </CardContent>
    </Card>
  );
} 