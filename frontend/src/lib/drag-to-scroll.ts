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

export function attachDragToScroll(element: HTMLElement, setIsDragging: (value: boolean) => void) {
  let state: {
    pointerId: number | null;
    startX: number;
    startY: number;
    scrollLeft: number;
    didDrag: boolean;
  } = {
    pointerId: null,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    didDrag: false,
  };
  let clickSuppressionTimeout: ReturnType<typeof setTimeout> | undefined;
  const clearClickSuppression = () => {
    clearTimeout(clickSuppressionTimeout);
    element.removeEventListener('click', suppressClick, { capture: true });
  };
  const suppressClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    clearClickSuppression();
  };
  const removeDocumentListeners = () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerEnd);
    document.removeEventListener('pointercancel', onPointerEnd);
  };

  const resetDragState = () => {
    removeDocumentListeners();
    state.pointerId = null;
    state.didDrag = false;
    setIsDragging(false);
  };

  const onPointerMove = (event: PointerEvent) => {
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
    if (state.pointerId !== event.pointerId) return;

    clearClickSuppression();
    if (state.didDrag && event.type === 'pointerup') {
      element.addEventListener('click', suppressClick, { capture: true });
      // A mouse click follows pointerup in the same task. Outside releases have no local click.
      clickSuppressionTimeout = setTimeout(clearClickSuppression, 0);
    }

    resetDragState();
  };

  const onPointerDown = (event: PointerEvent) => {
    clearClickSuppression();
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (isInteractiveTarget(event.target)) return;

    state = {
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
    element.removeEventListener('pointerdown', onPointerDown);
    removeDocumentListeners();
    clearClickSuppression();
  };
}
