import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

/**
 * Thin top-of-viewport progress bar that appears the instant a client-side
 * navigation starts and completes when the new route mounts. Gives immediate
 * "something is happening" feedback before the target page's skeletons render,
 * so navigation never feels stalled. Driven purely by Next's router events — no
 * external dependency.
 */
export function RouteProgressBar() {
  const router = useRouter();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const trickleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (trickleRef.current) clearInterval(trickleRef.current);
      if (hideRef.current) clearTimeout(hideRef.current);
      trickleRef.current = null;
      hideRef.current = null;
    };

    const start = () => {
      clearTimers();
      setVisible(true);
      setProgress(12);
      // Trickle toward ~90% while the route resolves; the completion handler
      // finishes the last stretch so a fast navigation still reads as "done".
      trickleRef.current = setInterval(() => {
        setProgress((p) => (p >= 90 ? p : p + Math.max(0.5, (90 - p) * 0.12)));
      }, 200);
    };

    const done = () => {
      clearTimers();
      setProgress(100);
      // Let the 100% frame paint, then fade out and reset.
      hideRef.current = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 220);
    };

    router.events.on('routeChangeStart', start);
    router.events.on('routeChangeComplete', done);
    router.events.on('routeChangeError', done);
    return () => {
      router.events.off('routeChangeStart', start);
      router.events.off('routeChangeComplete', done);
      router.events.off('routeChangeError', done);
      clearTimers();
    };
  }, [router.events]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[2000] h-0.5"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 200ms ease' }}
    >
      <div
        className="h-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]"
        style={{ width: `${progress}%`, transition: 'width 200ms ease' }}
      />
    </div>
  );
}
