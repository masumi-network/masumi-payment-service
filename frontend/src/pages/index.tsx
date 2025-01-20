import { MainLayout } from "@/components/layout/MainLayout";
import { MonitoredContracts } from "@/components/dashboard/MonitoredContracts";
import { useAppContext } from '@/lib/contexts/AppContext';


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
