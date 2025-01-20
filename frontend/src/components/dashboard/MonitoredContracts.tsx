/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useRouter } from 'next/router';
import { Button } from "@/components/ui/button";
import { CreateContractModal } from "./CreateContractModal";

function shortenAddress(address: string) {
  if (!address) return '';
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

export function MonitoredContracts({ paymentSourceData }: any) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const { state } = useAppContext();
  const contracts = state.paymentSources || [];
  const [showCreateModal, setShowCreateModal] = useState(false);

  const handleRowClick = (contractName: string) => {
    router.push(`/contract/${contractName}`);
  };

  useEffect(() => {
    if (paymentSourceData !== undefined) {
      setIsLoading(false);
    }
  }, [paymentSourceData]);

  const handleAddContract = () => {
    setShowCreateModal(true);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Monitored Contracts</CardTitle>
        </CardHeader>
        <div className="p-4">
          <Skeleton className="h-[200px]" />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Monitored Contracts</CardTitle>
        <Button onClick={handleAddContract}>
          Add Contract
        </Button>
      </CardHeader>
      <div className="p-4">
        {contracts.length === 0 ? (
          <div className="text-sm text-muted-foreground">No contracts found.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Contract Address</TableHead>
                <TableHead>Network</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contracts.map((contract) => (
                <TableRow
                  key={contract.id}
                  onClick={() => handleRowClick(contract.name || contract.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="font-mono">
                    {shortenAddress(contract.paymentContractAddress)}
                  </TableCell>
                  <TableCell>{contract.network}</TableCell>
                  <TableCell>Payment Contract</TableCell>
                  <TableCell>
                    <span className={`px-2 py-1 rounded-full ${getStatusColor(contract.isSyncing)}`}>
                      {contract.isSyncing ? 'Syncing' : 'Active'}
                    </span>
                  </TableCell>
                  <TableCell>{new Date(contract.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {showCreateModal && (
        <CreateContractModal onClose={() => setShowCreateModal(false)} />
      )}
    </Card>
  );
}

function getStatusColor(isSyncing: any) {
  if (isSyncing) {
    return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
  }
  return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
} 