import React, {
  createContext,
  useContext,
  ReactNode,
  useState,
  useCallback,
  useEffect,
} from 'react';

type Position = { x: number; y: number };

interface DialogContextType {
  position: Position;
  style: any;
  setActiveDialog: React.Dispatch<React.SetStateAction<{ width: number; height: number }>>;
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

const getInitialPosition = (): Position => {
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

const DialogContext = createContext<DialogContextType | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [position, setPosition] = useState<Position>(getInitialPosition());
  const [activeDialog, setActiveDialog] = useState({
    width: DEFAULT_DIALOG_WIDTH,
    height: DEFAULT_DIALOG_HEIGHT,
  });

  const updatePosition = useCallback((newPosition: Position) => {
    setPosition(newPosition);
    savePosition(newPosition);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (typeof window === 'undefined') return;

      const newPosition = {
        x: Math.max(0, (window.innerWidth - activeDialog.width) / 2),
        y: Math.max(0, (window.innerHeight - activeDialog.height) / 2),
      };

      updatePosition(newPosition);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updatePosition, activeDialog]);

  const value = {
    position,
    style: {
      position: 'fixed',
      left: `${position.x}px`,
      top: `${position.y}px`,
      margin: 0,
      transform: 'none',
      width: activeDialog.width,
      height: activeDialog.height,
      overflow: 'visible',
      padding: 0,
    },
    setActiveDialog,
  };

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

export function useDialogContext() {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('useDialogContext must be used within a DialogProvider');
  }
  return context;
}
