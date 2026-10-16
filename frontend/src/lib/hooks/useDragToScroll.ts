import { useCallback, useEffect, useRef, useState } from 'react';

import { attachDragToScroll } from '../drag-to-scroll';

export function useDragToScroll<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [isScrollable, setIsScrollable] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const updateScrollable = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = element.scrollWidth > element.clientWidth + 1;
    setIsScrollable(next);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    updateScrollable();

    const resizeObserver = new ResizeObserver(updateScrollable);
    resizeObserver.observe(element);

    const mutationObserver = new MutationObserver(updateScrollable);
    mutationObserver.observe(element, { childList: true, subtree: true });

    const detachDragToScroll = attachDragToScroll(element, setIsDragging);

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      detachDragToScroll();
    };
  }, [updateScrollable]);

  return { ref, isScrollable, isDragging };
}
