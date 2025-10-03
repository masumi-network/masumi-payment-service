import { useRouter } from 'next/router';
import { useEffect } from 'react';

export function useDynamicFavicon() {
  const router = useRouter();

  useEffect(() => {
    const updateFavicon = () => {
      const existingFavicon = document.querySelector(
        'link[rel="icon"]',
      ) as HTMLLinkElement;

      // Check if current URL contains "admin"
      const currentUrl = window.location.href;
      const isAdminRoute = currentUrl.includes('/admin');

      // Use admin favicon for admin routes, swagger favicon for everything else
      const faviconPath = isAdminRoute
        ? '/admin/admin_favicon.svg'
        : '/assets/swagger_favicon.svg';

      if (existingFavicon) {
        existingFavicon.href = faviconPath;
      } else {
        // Create favicon link if it doesn't exist
        const newFavicon = document.createElement('link');
        newFavicon.rel = 'icon';
        newFavicon.href = faviconPath;
        document.head.appendChild(newFavicon);
      }
    };

    updateFavicon();
  }, [router.pathname]);
}
