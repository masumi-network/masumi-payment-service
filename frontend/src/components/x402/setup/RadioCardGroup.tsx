import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type RadioCardOption<T extends string> = {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned extra, for example a status badge. */
  aside?: ReactNode;
};

const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight']);
const PREVIOUS_KEYS = new Set(['ArrowUp', 'ArrowLeft']);

/**
 * Single-choice group rendered as cards. Follows the ARIA radio group pattern: one tab stop
 * (the checked card), arrow keys move and select, and every card reads as a radio.
 */
export function RadioCardGroup<T extends string>({
  labelledBy,
  options,
  value,
  onChange,
  columns = 1,
  isDisabled = false,
}: {
  labelledBy: string;
  options: RadioCardOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  columns?: 1 | 2;
  isDisabled?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex((option) => option.value === value);
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = NEXT_KEYS.has(event.key) ? 1 : PREVIOUS_KEYS.has(event.key) ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const nextIndex = (index + step + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    refs.current[nextIndex]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={isDisabled || undefined}
      className={cn('grid gap-2', columns === 2 && 'sm:grid-cols-2')}
    >
      {options.map((option, index) => {
        const isChecked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={isChecked}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={isDisabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'flex w-full items-start gap-3 rounded-xl border p-4 text-start transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
              isChecked
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                : 'hover:bg-muted/40 disabled:hover:bg-transparent',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                isChecked ? 'border-primary' : 'border-muted-foreground/60',
              )}
            >
              {isChecked && <span className="size-2 rounded-full bg-primary" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{option.title}</span>
              {option.description && (
                <span className="mt-0.5 block text-pretty text-xs leading-snug text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
            {option.aside && <span className="shrink-0">{option.aside}</span>}
          </button>
        );
      })}
    </div>
  );
}
