import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAppContext } from '@/lib/contexts/AppContext';
import { compatibilityX402Target } from '@/lib/x402-navigation';

export default function X402ChainsPage() {
  const router = useRouter();
  const { setActiveRail } = useAppContext();

  useEffect(() => {
    if (!router.isReady) return;
    setActiveRail('x402');
    void router.replace(compatibilityX402Target('/x402/chains', router.query));
  }, [router.isReady, router.query, router, setActiveRail]);

  return null;
}
