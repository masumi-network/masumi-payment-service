import { useCallback, useEffect, useRef, useState } from 'react';

const DRAG_THRESHOLD_PX = 5;

const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, label, [role="button"], [contenteditable="true"], [data-no-drag-scroll]';

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  if (!interactive) return false;
  // rowActivation sets role="button" on clickable table rows for keyboard a11y.
  // Row chrome should still support drag-to-scroll; nested buttons/links stay excluded.
  if (interactive instanceof HTMLTableRowElement && interactive.getAttribute('role') === 'button') {
    return false;
  }
  return true;
}

export function useDragToScroll<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const isScrollableRef = useRef(false);
  const dragState = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    scrollLeft: number;
    didDrag: boolean;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    didDrag: false,
  });
  const [isScrollable, setIsScrollable] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const updateScrollable = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = element.scrollWidth > element.clientWidth + 1;
    isScrollableRef.current = next;
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

    const resetDragState = () => {
      dragState.current.pointerId = null;
      dragState.current.didDrag = false;
      setIsDragging(false);
    };

    const onPointerMove = (event: PointerEvent) => {
      const state = dragState.current;
      if (state.pointerId !== event.pointerId) return;

      const deltaX = event.pageX - state.startX;
      const deltaY = event.pageY - state.startY;

      if (!state.didDrag) {
        if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          resetDragState();
          return;
        }

        state.didDrag = true;
        setIsDragging(true);
      }

      event.preventDefault();
      element.scrollLeft = state.scrollLeft - deltaX;
    };

    const onPointerEnd = (event: PointerEvent) => {
      const state = dragState.current;
      if (state.pointerId !== event.pointerId) return;

      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);

      if (state.didDrag) {
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        };
        element.addEventListener('click', suppressClick, {
          capture: true,
          once: true,
        });
      }

      resetDragState();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (event.pointerType === 'touch') return;
      if (!isScrollableRef.current) return;
      if (isInteractiveTarget(event.target)) return;

      dragState.current = {
        pointerId: event.pointerId,
        startX: event.pageX,
        startY: event.pageY,
        scrollLeft: element.scrollLeft,
        didDrag: false,
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerEnd);
      document.addEventListener('pointercancel', onPointerEnd);
    };

    element.addEventListener('pointerdown', onPointerDown);

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      element.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [updateScrollable]);

  return { ref, isScrollable, isDragging };
}
