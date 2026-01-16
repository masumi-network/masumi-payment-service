import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog';
import { Button } from './button';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

interface ErrorDialogProps {
  open: boolean;
  onClose: () => void;
  error: {
    code?: number;
    message: string;
    details?: unknown;
  };
}

export function ErrorDialog({ open, onClose, error }: ErrorDialogProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="z-9999 fixed!" hideClose>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="bg-destructive/10 text-destructive px-2 py-1 rounded-full text-sm font-medium">
                {error.code || '500'}
              </div>
              <X className="h-4 w-4 text-destructive" />
            </div>
            Error Occurred
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {error.message || 'An unexpected error occurred'}
          </p>

          {!!error.details && (
            <div className="space-y-2">
              <Button
                variant="ghost"
                className="w-full justify-between"
                onClick={() => setShowDetails(!showDetails)}
              >
                <span className="text-sm">View Details</span>
                {showDetails ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>

              <div
                className={cn(
                  'overflow-hidden transition-all',
                  showDetails ? 'max-h-96' : 'max-h-0',
                )}
              >
                <pre className="text-xs bg-muted/50 p-4 rounded-md overflow-auto">
                  {JSON.stringify(error.details, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
