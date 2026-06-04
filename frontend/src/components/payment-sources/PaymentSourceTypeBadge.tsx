import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  getPaymentSourceTypeShortLabel,
  getPaymentSourceTypeTone,
  type PaymentSourceType,
} from '@/lib/payment-source-type';

interface PaymentSourceTypeBadgeProps {
  paymentSourceType: PaymentSourceType;
  className?: string;
  showDefault?: boolean;
}

export function PaymentSourceTypeBadge({
  paymentSourceType,
  className,
  showDefault = false,
}: PaymentSourceTypeBadgeProps) {
  const tone = getPaymentSourceTypeTone(paymentSourceType);
  const label = getPaymentSourceTypeShortLabel(paymentSourceType);

  return (
    <Badge
      variant={tone === 'default' ? 'success' : 'outline'}
      className={cn(
        'whitespace-nowrap',
        tone === 'legacy' &&
          'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
        className,
      )}
    >
      {label}
      {showDefault && tone === 'default' ? ' default' : tone === 'legacy' ? ' legacy' : ''}
    </Badge>
  );
}
