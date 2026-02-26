import { useRef, useState, useLayoutEffect } from 'react';
import { cn } from '@/lib/utils';

interface Tab {
  name: string;
  count?: number | null;
  variant?: 'default' | 'alert';
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabName: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onTabChange, className }: TabsProps) {
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const index = tabs.findIndex((tab) => tab.name === activeTab);
    const el = index >= 0 ? tabsRef.current[index] : null;
    if (el) {
      const left = el.offsetLeft;
      const width = el.offsetWidth;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Measuring DOM requires synchronous state update to prevent visual artifacts
      setIndicatorStyle({ left, width });
    }
  }, [tabs, activeTab]);

  return (
    <div className={cn('flex gap-6 border-b relative', className)}>
      <div
        className="absolute bottom-0 h-[3px] bg-primary rounded-full transition-all duration-300 ease-out"
        style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
      />
      {tabs.map((tab, index) => (
        <button
          key={tab.name}
          ref={(el) => {
            if (el) tabsRef.current[index] = el;
          }}
          onClick={() => onTabChange(tab.name)}
          className={cn(
            'pb-4 relative text-sm transition-colors duration-200',
            activeTab === tab.name ? 'text-primary font-medium' : 'text-muted-foreground',
          )}
        >
          <div className="flex items-center gap-2">
            {tab.name}
            {tab.count != null && tab.count > 0 && (
              <span
                className={cn(
                  'rounded-full min-w-5 h-5 px-1.5 text-xs flex items-center justify-center animate-pop-in',
                  tab.variant === 'alert'
                    ? 'bg-destructive text-white'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {tab.count}
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
