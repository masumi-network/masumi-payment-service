import { useRouter } from 'next/router';
import { useEffect } from 'react';

const ADMIN_FAVICON = '/assets/admin_favicon.svg';
const SWAGGER_FAVICON = '/assets/swagger_favicon.svg';

/**
 * Swap the document favicon for the admin Next shell.
 *
 * The app is mounted at basePath `/admin`, so `window.location.href` always
 * contains `/admin` and the old href check never selected the swagger icon.
 * `router.pathname` is relative to basePath (e.g. `/developers`), which is the
 * stable signal for admin UI routes served by this app. Standalone Swagger UI
 * at `/docs` sets its own favicon via swagger-ui-express.
 */
export function useDynamicFavicon() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;

    const existingFavicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    const isAdminUiRoute = router.pathname !== '/404';
    const faviconPath = isAdminUiRoute ? ADMIN_FAVICON : SWAGGER_FAVICON;

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
