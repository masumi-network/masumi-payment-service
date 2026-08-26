import { useEffect, useState } from 'react';
import { addMonths } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  CALENDAR_WEEKDAY_LABELS,
  buildCalendarWeeks,
  formatCalendarDate,
  formatCalendarDisplay,
  formatCalendarMonth,
  isCalendarDayDisabled,
  isCalendarMonthOutOfBounds,
  isSameCalendarDay,
  isSameCalendarMonth,
  resolveCalendarMonth,
} from '@/lib/date-picker-calendar';

type DatePickerProps = Readonly<{
  id?: string;
  /** The chosen day as `yyyy-MM-dd`, or an empty string for none. */
  value: string;
  onChange: (value: string) => void;
  /** Inclusive bounds, both as `yyyy-MM-dd`. */
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
}>;

/**
 * A day picker on a calendar, rather than the browser's own date input.
 *
 * The native control renders a locale-ordered `dd.mm.yyyy` mask that reads
 * differently for every operator and gives no view of the month being
 * reported on. A calendar shows the period the way an accountant thinks of it,
 * and it can refuse a day that lies outside the allowed range.
 */
export function DatePicker({
  id,
  value,
  onChange,
  min,
  max,
  placeholder = 'Pick a day',
  className,
}: DatePickerProps) {
  const bounds = { min, max };
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => resolveCalendarMonth(value, bounds));

  // Opening on a stale month would hide the day the field already holds.
  useEffect(() => {
    if (isOpen) setVisibleMonth(resolveCalendarMonth(value, bounds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, value, min, max]);

  const today = new Date();
  const selected = formatCalendarDisplay(value);
  const weeks = buildCalendarWeeks(visibleMonth);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          className={cn(
            'w-full justify-start font-normal',
            selected == null && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {selected ?? placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="Previous month"
            disabled={isCalendarMonthOutOfBounds(visibleMonth, -1, bounds)}
            onClick={() => setVisibleMonth((current) => addMonths(current, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span aria-live="polite" className="text-sm font-medium">
            {formatCalendarMonth(visibleMonth)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="Next month"
            disabled={isCalendarMonthOutOfBounds(visibleMonth, 1, bounds)}
            onClick={() => setVisibleMonth((current) => addMonths(current, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <table className="border-separate border-spacing-0.5">
          <thead>
            <tr>
              {CALENDAR_WEEKDAY_LABELS.map((weekday) => (
                <th
                  key={weekday}
                  scope="col"
                  className="h-7 w-8 text-[11px] font-normal text-muted-foreground"
                >
                  {weekday}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={formatCalendarDate(week[0])}>
                {week.map((day) => {
                  const dayValue = formatCalendarDate(day);
                  const isDisabled = isCalendarDayDisabled(day, bounds);
                  const isSelected = dayValue === value;
                  return (
                    <td key={dayValue}>
                      <button
                        type="button"
                        disabled={isDisabled}
                        aria-pressed={isSelected}
                        aria-current={isSameCalendarDay(day, today) ? 'date' : undefined}
                        aria-label={formatCalendarDisplay(dayValue) ?? dayValue}
                        onClick={() => {
                          onChange(dayValue);
                          setIsOpen(false);
                        }}
                        className={cn(
                          'h-8 w-8 rounded-md text-xs transition-colors',
                          isSameCalendarMonth(day, visibleMonth)
                            ? 'text-foreground'
                            : 'text-muted-foreground/50',
                          isSameCalendarDay(day, today) && !isSelected && 'ring-1 ring-border',
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-muted disabled:hover:bg-transparent',
                          isDisabled && 'cursor-not-allowed opacity-30',
                        )}
                      >
                        {day.getDate()}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}
