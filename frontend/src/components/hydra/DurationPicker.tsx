/**
 * A duration, entered in the units people actually think in.
 *
 * These settings span four orders of magnitude: a settle time is minutes, a
 * dispute window is days. Asking for either in seconds gives you `43200` in a
 * box, which nobody can check at a glance and which invites a typo worth an
 * order of magnitude. Days, hours and minutes are separate fields for the same
 * reason a clock has separate hands.
 *
 * The value carried in and out is seconds, so callers keep the protocol's own
 * unit and never deal with the split.
 */

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'not set';
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  const remainder = Math.round(seconds % MINUTE);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  // Kept rather than rounded: a value set through the API need not land on a
  // minute, and hiding the remainder would make this look lossless when it is
  // not.
  if (remainder > 0) parts.push(`${remainder} second${remainder === 1 ? '' : 's'}`);
  return parts.length === 0 ? `${Math.round(seconds)} seconds` : parts.join(' ');
}

function Segment({
  id,
  label,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  max?: number;
  onChange: (next: number) => void;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Input
        id={id}
        inputMode="numeric"
        aria-label={label}
        className="w-16 text-right tabular-nums"
        value={String(value)}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, '');
          const parsed = digits === '' ? 0 : Number(digits);
          onChange(max === undefined ? parsed : Math.min(parsed, max));
        }}
      />
      <span className="text-sm text-muted-foreground">{label}</span>
    </span>
  );
}

export function DurationPicker({
  id,
  label,
  seconds,
  onChange,
  hint,
  warning,
  error,
  showDays = true,
}: {
  id: string;
  label: string;
  seconds: number;
  onChange: (nextSeconds: number) => void;
  hint?: string;
  /** Amber: the value is allowed but a poor choice. */
  warning?: string | null;
  /** Red: the value will be refused, so the form cannot be submitted with it. */
  error?: string | null;
  /** Off for durations that are never more than a few hours, to keep the row short. */
  showDays?: boolean;
}) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const days = showDays ? Math.floor(safe / DAY) : 0;
  const hours = Math.floor((safe - days * DAY) / HOUR);
  const minutes = Math.floor((safe - days * DAY - hours * HOUR) / MINUTE);
  // Whatever is left below a minute. Rounding it away would silently change a
  // value the operator never touched: a 220-second dispute window opened here
  // and saved again would become 240.
  const subMinute = safe - days * DAY - hours * HOUR - minutes * MINUTE;

  const emit = (next: { days?: number; hours?: number; minutes?: number }) =>
    onChange(
      (next.days ?? days) * DAY +
        (next.hours ?? hours) * HOUR +
        (next.minutes ?? minutes) * MINUTE +
        subMinute,
    );

  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-hours`}>{label}</Label>
      <div className="flex flex-wrap items-center gap-3">
        {showDays && (
          <Segment
            id={`${id}-days`}
            label="days"
            value={days}
            onChange={(value) => emit({ days: value })}
          />
        )}
        <Segment
          id={`${id}-hours`}
          label="hours"
          value={hours}
          max={showDays ? 23 : undefined}
          onChange={(value) => emit({ hours: value })}
        />
        <Segment
          id={`${id}-minutes`}
          label="minutes"
          value={minutes}
          max={59}
          onChange={(value) => emit({ minutes: value })}
        />
        <span className="text-xs text-muted-foreground">= {formatDuration(safe)}</span>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {warning && !error && <p className="text-xs text-amber-700 dark:text-amber-400">{warning}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
