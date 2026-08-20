import { useEffect } from 'react';
import { useRouter } from 'next/router';

// The x402 rail used to live entirely on this one page, tab-switched via
// `?tab=`. It is now split into real routes under /x402/* (mirroring how
// Cardano's Wallets/Transactions are separate sidebar pages), so this path
// just forwards old links and bookmarks to the new default landing page.
export default function X402RedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/x402/wallets');
  }, [router]);

  return null;
}
