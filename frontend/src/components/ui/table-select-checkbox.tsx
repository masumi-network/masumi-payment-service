import { Checkbox } from '@/components/ui/checkbox';

type TableSelectAllCheckboxProps = {
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  disabled?: boolean;
  'aria-label'?: string;
};

export function TableSelectAllCheckbox({
  allSelected,
  someSelected,
  onToggleAll,
  disabled,
  'aria-label': ariaLabel = 'Select all rows',
}: TableSelectAllCheckboxProps) {
  return (
    <Checkbox
      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
      onCheckedChange={onToggleAll}
      aria-label={ariaLabel}
      disabled={disabled}
    />
  );
}

type TableSelectRowCheckboxProps = {
  checked: boolean;
  onToggle: () => void;
  'aria-label': string;
};

export function TableSelectRowCheckbox({
  checked,
  onToggle,
  'aria-label': ariaLabel,
}: TableSelectRowCheckboxProps) {
  return <Checkbox aria-label={ariaLabel} checked={checked} onCheckedChange={onToggle} />;
}
