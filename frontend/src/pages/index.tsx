/* eslint-disable @typescript-eslint/no-explicit-any */
import { MainLayout } from "@/components/layout/MainLayout";
import { MonitoredContracts } from "@/components/dashboard/MonitoredContracts";
import { useAppContext } from '@/lib/contexts/AppContext';
import { GetStaticProps } from 'next';
import Head from "next/head";

interface OverviewProps {
  initialPaymentSources: any[];
}

export const getStaticProps: GetStaticProps<OverviewProps> = async () => {
  try {
    // Return empty initial data - will be populated client-side
    return {
      props: {
        initialPaymentSources: []
      }
    };
  } catch (error) {
    console.error('Error fetching payment sources:', error);
    return {
      props: {
        initialPaymentSources: []
      }
    };
  }
};

export default function Overview({ initialPaymentSources }: OverviewProps) {
  const { state } = useAppContext();
  const paymentSources = state.paymentSources.length > 0 ? state.paymentSources : initialPaymentSources;

  return (
    <div className="">
      <Head>
        <title>Masumi | Admin Interface</title>
      </Head>
      <MainLayout>
        <div className="space-y-6">
          <MonitoredContracts paymentSourceData={paymentSources} />
        </div>
      </MainLayout>
    </div>
  );
}
