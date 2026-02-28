import { PiSpinnerGap } from 'react-icons/pi';
import { cn } from '@/lib/utils';

interface SpinnerProps {
  /** Size of the spinner in pixels */
  size?: number;
  /** Add a container div with centered alignment */
  addContainer?: boolean;
  /** Additional classes for the spinner */
  className?: string;
  /** Additional classes for the container */
  containerClassName?: string;
}

export function Spinner({
  size = 16,
  addContainer = false,
  className,
  containerClassName,
}: SpinnerProps) {
  const spinner = (
    <PiSpinnerGap className={cn('animate-spin', className)} style={{ width: size, height: size }} />
  );

  if (addContainer) {
    return (
      <div className={cn('w-full p-5 flex justify-center items-center', containerClassName)}>
        {spinner}
      </div>
    );
  }

  return spinner;
}
