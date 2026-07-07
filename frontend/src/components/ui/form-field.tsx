import { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Label + input slot + validation error in the app's standard layout.
 *
 * Replaces the hand-rolled pattern repeated across dialogs:
 *   <Label>...</Label>
 *   <Input ... />
 *   {errors.x && <p className="text-xs text-destructive mt-1">{errors.x.message}</p>}
 *
 * Works with react-hook-form by passing `error={errors.field?.message}`.
 */
export function FormField({
  label,
  htmlFor,
  required,
  error,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  /** Validation message; when set it renders below the field in destructive style. */
  error?: string;
  /** Muted helper text shown when there is no error. */
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive mt-1">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground mt-1">{hint}</p>
      ) : null}
    </div>
  );
}
