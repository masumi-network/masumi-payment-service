import { SetupWelcome } from '@/components/setup/SetupWelcome';
import { MainLayout } from '@/components/layout/MainLayout';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';

export default function SetupPage() {
    const { apiKey, network, setNetwork, setIsSetupMode } = useAppContext();
    const router = useRouter();

    const initialSyncDone = useRef(false);

    useEffect(() => {
        setIsSetupMode(true);
    }, [setIsSetupMode]);

    // Sync URL network param to AppContext only once on initial mount
    useEffect(() => {
        if (initialSyncDone.current) return;
        if (!router.isReady) return;

        initialSyncDone.current = true;


        const urlNetwork = router.query.network;
        if (typeof urlNetwork === 'string') {
            const normalized =
                urlNetwork.toLowerCase() === 'mainnet' ? 'Mainnet' : 'Preprod';
            setNetwork(normalized);
        }
    }, [router.isReady, router.query.network, setNetwork]);

    useEffect(() => {
        if (!apiKey) {
            router.push('/');
        }
    }, [apiKey, router]);

    if (!apiKey) {
        return null;
    }

    return (
        <>
            <Head>
                <title>{network} Setup | Admin Interface</title>
            </Head>
            <MainLayout>
                <SetupWelcome networkType={network} />
            </MainLayout>
        </>
    );
}
