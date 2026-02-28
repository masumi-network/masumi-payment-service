import { useState, useCallback, MouseEvent as ReactMouseEvent, useEffect, useRef } from 'react';

interface Position {
  x: number;
  y: number;
}

interface UseDialogReturn {
  position: Position;
  isDragging: boolean;
  onMouseDown: (e: ReactMouseEvent) => void;
  style: any;
  dialogRef: React.RefObject<HTMLDivElement | null>;
}

const DEFAULT_DIALOG_WIDTH = 600;
const DEFAULT_DIALOG_HEIGHT = 547;

const DIALOG_POSITION_KEY = 'dialog-position';

const getStoredPosition = (): Position | null => {
  if (typeof window === 'undefined') return null;

  try {
    const stored = localStorage.getItem(DIALOG_POSITION_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Error reading dialog position from localStorage:', e);
  }
  return null;
};

const savePosition = (position: Position) => {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(DIALOG_POSITION_KEY, JSON.stringify(position));
  } catch (e) {
    console.error('Error saving dialog position to localStorage:', e);
  }
};

const getInitialPosition = (initialPosition?: Position): Position => {
  if (initialPosition) return initialPosition;

  const storedPosition = getStoredPosition();
  if (storedPosition) return storedPosition;

  if (typeof window === 'undefined') {
    return { x: 0, y: 0 };
  }

  return {
    x: Math.max(0, (window.innerWidth - DEFAULT_DIALOG_WIDTH) / 2),
    y: Math.max(0, (window.innerHeight - DEFAULT_DIALOG_HEIGHT) / 2),
  };
};

export const useDialog = (initialPosition?: Position): UseDialogReturn => {
  const [position, setPosition] = useState<Position>(getInitialPosition(initialPosition));
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<Position>({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback((newPosition: Position) => {
    setPosition(newPosition);
    savePosition(newPosition);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (typeof window === 'undefined' || !dialogRef.current) return;

      const dialogWidth = dialogRef.current.offsetWidth ?? DEFAULT_DIALOG_WIDTH;
      const dialogHeight = dialogRef.current.offsetHeight ?? DEFAULT_DIALOG_HEIGHT;

      const newPosition = {
        x: Math.max(0, (window.innerWidth - dialogWidth) / 2),
        y: Math.max(0, (window.innerHeight - dialogHeight) / 2),
      };

      updatePosition(newPosition);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updatePosition]);

  const onMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      if (!dialogRef.current) return;

      setIsDragging(true);
      isDraggingRef.current = true;

      const rect = dialogRef.current.getBoundingClientRect();
      dragStartRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!isDraggingRef.current || !dialogRef.current || typeof window === 'undefined') return;

        const newX = e.clientX - dragStartRef.current.x;
        const newY = e.clientY - dragStartRef.current.y;

        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        const dialogWidth = dialogRef.current.offsetWidth ?? DEFAULT_DIALOG_WIDTH;
        const dialogHeight = dialogRef.current.offsetHeight ?? DEFAULT_DIALOG_HEIGHT;

        const margin = 20;
        const minX = margin;
        const maxX = windowWidth - dialogWidth - margin;
        const minY = margin;
        const maxY = windowHeight - dialogHeight - margin;

        const boundedX = Math.min(Math.max(newX, minX), maxX);
        const boundedY = Math.min(Math.max(newY, minY), maxY);

        updatePosition({
          x: boundedX,
          y: boundedY,
        });
      };

      const onMouseUp = () => {
        setIsDragging(false);
        isDraggingRef.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [updatePosition],
  );

  return {
    position,
    isDragging,
    onMouseDown,
    style: {
      position: 'fixed',
      left: `${position.x}px`,
      top: `${position.y}px`,
      margin: 0,
      transform: 'none',
      width: DEFAULT_DIALOG_WIDTH,
      height: DEFAULT_DIALOG_HEIGHT,
      overflow: 'visible',
      padding: 0,
    },
    dialogRef,
  };
};
