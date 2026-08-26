import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { compatibilityX402Target } from '@/lib/x402-navigation';

export default function X402AlertsPage() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    void router.replace(compatibilityX402Target('/x402/alerts', router.query));
  }, [router.isReady, router.query, router]);

  return null;
}
