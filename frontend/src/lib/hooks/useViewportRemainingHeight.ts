import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

/** Pixel height from the element's top edge to the bottom of the viewport (clamped). */
export function useViewportRemainingHeight(
  ref: RefObject<HTMLElement | null>,
  options?: { bottomInset?: number; enabled?: boolean },
) {
  const bottomInset = options?.bottomInset ?? 24;
  const enabled = options?.enabled ?? true;
  const [height, setHeight] = useState<number | undefined>();

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    setHeight(Math.max(160, Math.floor(window.innerHeight - top - bottomInset)));
  }, [ref, bottomInset]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    const el = ref.current;
    if (el) {
      observer.observe(el);
      let parent = el.parentElement;
      while (parent) {
        observer.observe(parent);
        parent = parent.parentElement;
      }
    }
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [enabled, measure, ref]);

  return enabled ? height : undefined;
}
