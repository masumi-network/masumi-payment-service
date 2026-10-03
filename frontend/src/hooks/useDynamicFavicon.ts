import { useRouter } from 'next/router';
import { useEffect } from 'react';

const ADMIN_FAVICON = '/assets/admin_favicon.svg';

/** Admin Next shell only; Swagger at `/docs` sets its own favicon. */
export function useDynamicFavicon() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;

    const existingFavicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    const faviconPath = ADMIN_FAVICON;

    if (existingFavicon) {
      existingFavicon.href = faviconPath;
    } else {
      const newFavicon = document.createElement('link');
      newFavicon.rel = 'icon';
      newFavicon.href = faviconPath;
      document.head.appendChild(newFavicon);
    }
  }, [router.isReady, router.pathname]);
}
