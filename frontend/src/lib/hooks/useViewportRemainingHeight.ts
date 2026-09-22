import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

/** Pixel height from the element's top edge to the bottom of the viewport (clamped). */
export function useViewportRemainingHeight(
  ref: RefObject<HTMLElement | null>,
  options?: { bottomInset?: number },
) {
  const bottomInset = options?.bottomInset ?? 24;
  const [height, setHeight] = useState<number | undefined>();

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const cssMin = parseFloat(getComputedStyle(el).minHeight) || 0;
    setHeight(Math.max(cssMin, window.innerHeight - top - bottomInset));
  }, [ref, bottomInset]);

  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    const parent = ref.current?.parentElement;
    if (parent) observer.observe(parent);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure, ref]);

  return height;
}
