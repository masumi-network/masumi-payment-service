import { useRef, useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface Tab {
  name: string;
  count?: number | null;
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

  useEffect(() => {
    const index = tabs.findIndex((tab) => tab.name === activeTab);
    const el = index >= 0 ? tabsRef.current[index] : null;
    if (el) {
      const left = el.offsetLeft;
      const width = el.offsetWidth;
      queueMicrotask(() => setIndicatorStyle({ left, width }));
    }
  }, [tabs, activeTab]);

  return (
    <div className={cn('flex gap-6 border-b relative', className)}>
      <div
        className="absolute bottom-0 h-0.5 bg-primary transition-all duration-300 ease-out"
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
            activeTab === tab.name ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <div className="flex items-center gap-2">
            {tab.name}
            {tab.count && (
              <span className="bg-destructive text-white rounded-full w-4 h-4 text-xs flex items-center justify-center">
                {tab.count}
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
