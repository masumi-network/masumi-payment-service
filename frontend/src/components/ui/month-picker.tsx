import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatDisplayMonth(value: string): string {
  const [yearStr, monthStr] = value.split('-');
  const d = new Date(Number(yearStr), Number(monthStr) - 1, 1);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

interface MonthPickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function MonthPicker({ value, onChange, className }: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => {
    const [yearStr] = value.split('-');
    return Number(yearStr);
  });
  const containerRef = useRef<HTMLDivElement>(null);

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthIdx = now.getMonth();

  const [selectedYear, selectedMonthIdx] = (() => {
    const [y, m] = value.split('-');
    return [Number(y), Number(m) - 1];
  })();

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleEscape);
      };
    }
  }, [open, handleClickOutside, handleEscape]);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev) setViewYear(selectedYear);
      return !prev;
    });
  }, [selectedYear]);

  const isMonthDisabled = (year: number, monthIdx: number) => {
    if (year > currentYear) return true;
    if (year === currentYear && monthIdx > currentMonthIdx) return true;
    return false;
  };

  const isYearForwardDisabled = viewYear >= currentYear;

  const selectMonth = (monthIdx: number) => {
    if (isMonthDisabled(viewYear, monthIdx)) return;
    const val = `${viewYear}-${String(monthIdx + 1).padStart(2, '0')}`;
    onChange(val);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Button
        type="button"
        variant="outline"
        className="w-[200px] justify-start gap-2 font-normal"
        onClick={handleToggle}
      >
        <Calendar className="h-4 w-4 text-muted-foreground" />
        {formatDisplayMonth(value)}
      </Button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-[280px] rounded-md border bg-popover p-3 shadow-md animate-in fade-in-0 zoom-in-95">
          {/* Year navigation */}
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => setViewYear((y) => y - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium">{viewYear}</span>
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded-md h-7 w-7 transition-colors',
                isYearForwardDisabled
                  ? 'text-muted-foreground/40 cursor-not-allowed'
                  : 'hover:bg-accent hover:text-accent-foreground',
              )}
              onClick={() => !isYearForwardDisabled && setViewYear((y) => y + 1)}
              disabled={isYearForwardDisabled}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Month grid */}
          <div className="grid grid-cols-4 gap-1">
            {MONTH_NAMES.map((name, idx) => {
              const disabled = isMonthDisabled(viewYear, idx);
              const isSelected = viewYear === selectedYear && idx === selectedMonthIdx;
              return (
                <button
                  key={idx}
                  type="button"
                  disabled={disabled}
                  onClick={() => selectMonth(idx)}
                  className={cn(
                    'h-9 rounded-md text-sm transition-colors',
                    disabled && 'text-muted-foreground/40 cursor-not-allowed',
                    !disabled && !isSelected && 'hover:bg-accent hover:text-accent-foreground',
                    isSelected && 'bg-primary text-primary-foreground',
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
