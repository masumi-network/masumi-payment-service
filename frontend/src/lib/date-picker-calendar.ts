import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parse,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
} from 'date-fns';

/** The wire format for every report date field. */
export const CALENDAR_DATE_FORMAT = 'yyyy-MM-dd';

/** Weeks start on Monday, which is what the operators of this service expect. */
const WEEK_START = 1 as const;

export const CALENDAR_WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

/** Reads a `yyyy-MM-dd` field, or null when it is empty or not a real day. */
export function parseCalendarDate(value: string): Date | null {
  if (!value) return null;
  const parsed = parse(value, CALENDAR_DATE_FORMAT, new Date());
  return isValid(parsed) && format(parsed, CALENDAR_DATE_FORMAT) === value ? parsed : null;
}

export function formatCalendarDate(date: Date): string {
  return format(date, CALENDAR_DATE_FORMAT);
}

/** How a chosen day is shown on the trigger: unambiguous across locales. */
export function formatCalendarDisplay(value: string): string | null {
  const parsed = parseCalendarDate(value);
  return parsed == null ? null : format(parsed, 'd MMM yyyy');
}

export function formatCalendarMonth(month: Date): string {
  return format(month, 'MMMM yyyy');
}

/**
 * The six-week grid for one month, padded with the neighbouring days so every
 * row holds seven dates. A fixed shape keeps the popover from resizing as the
 * month changes.
 */
export function buildCalendarWeeks(month: Date): Date[][] {
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: WEEK_START }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: WEEK_START }),
  });
  const weeks: Date[][] = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  return weeks;
}

export function isSameCalendarDay(left: Date, right: Date): boolean {
  return formatCalendarDate(left) === formatCalendarDate(right);
}

export function isSameCalendarMonth(left: Date, right: Date): boolean {
  return format(left, 'yyyy-MM') === format(right, 'yyyy-MM');
}

/** True when a day falls outside the allowed bounds, which are inclusive. */
export function isCalendarDayDisabled(
  day: Date,
  bounds: Readonly<{ min?: string; max?: string }>,
): boolean {
  const value = formatCalendarDate(day);
  if (bounds.min && value < bounds.min) return true;
  return Boolean(bounds.max && value > bounds.max);
}

/** True when every day of a month lies past a bound, so paging there is futile. */
export function isCalendarMonthOutOfBounds(
  month: Date,
  direction: -1 | 1,
  bounds: Readonly<{ min?: string; max?: string }>,
): boolean {
  const target = addMonths(month, direction);
  if (direction === 1) {
    return Boolean(bounds.max && formatCalendarDate(startOfMonth(target)) > bounds.max);
  }
  return Boolean(bounds.min && formatCalendarDate(endOfMonth(target)) < bounds.min);
}

/**
 * A month to open on: the chosen day, else the nearest allowed month to today.
 */
export function resolveCalendarMonth(
  value: string,
  bounds: Readonly<{ min?: string; max?: string }>,
  today = new Date(),
): Date {
  const chosen = parseCalendarDate(value);
  if (chosen != null) return startOfMonth(chosen);
  const maximum = bounds.max == null ? null : parseCalendarDate(bounds.max);
  if (maximum != null && startOfDay(today) > maximum) return startOfMonth(maximum);
  const minimum = bounds.min == null ? null : parseCalendarDate(bounds.min);
  if (minimum != null && startOfDay(today) < minimum) return startOfMonth(minimum);
  return startOfMonth(today);
}

/** The range a custom period starts from, so the fields are never empty. */
export function defaultCustomDateRange(
  today = new Date(),
): Readonly<{ start: string; end: string }> {
  return {
    start: formatCalendarDate(subDays(startOfDay(today), 29)),
    end: formatCalendarDate(startOfDay(today)),
  };
}
