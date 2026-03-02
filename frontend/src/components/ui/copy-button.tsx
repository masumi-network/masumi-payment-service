import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'react-toastify';

interface CopyButtonProps {
  value: string;
  className?: string;
}

export function CopyButton({ value, className }: CopyButtonProps) {
  const [hasCopied, setHasCopied] = useState(false);

  const copyToClipboard = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    await navigator.clipboard.writeText(value);
    setHasCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setHasCopied(false), 2000);
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(className || 'h-8 w-8', 'relative')}
      onClick={copyToClipboard}
      type="button"
    >
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center transition-all duration-150',
          hasCopied ? 'opacity-0 scale-75' : 'opacity-100 scale-100',
        )}
      >
        <Copy className="h-4 w-4" />
      </span>
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center transition-all duration-150',
          hasCopied ? 'opacity-100 scale-100' : 'opacity-0 scale-75',
        )}
      >
        <Check className="h-4 w-4 text-green-500" />
      </span>
    </Button>
  );
}
