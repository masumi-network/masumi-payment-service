import { MainLayout } from "@/components/layout/MainLayout";
import { MonitoredContracts } from "@/components/dashboard/MonitoredContracts";
import { TransactionList } from "@/components/dashboard/TransactionList";
import { useAppContext } from '@/lib/contexts/AppContext';
import { useEffect } from "react";

export default function Overview() {
  const { state } = useAppContext();

  return (
    <MainLayout>
      <div className="space-y-6">
        <MonitoredContracts paymentSourceData={state.paymentSources} />
        {/* <TransactionList /> */}
      </div>
    </MainLayout>
  );
}
