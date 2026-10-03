import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { legacyX402Target } from '@/lib/x402-navigation';

// The x402 rail used to live entirely on this one page, tab-switched via
// `?tab=`. It is now split into real routes under /x402/* (mirroring how
// Cardano's Wallets/Transactions are separate sidebar pages), so this path
// just forwards old links and bookmarks to the new default landing page.
export default function X402RedirectPage() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    void router.replace(legacyX402Target(router.query));
  }, [router.isReady, router.query, router]);

  return null;
}
