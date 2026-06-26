import { useRouter } from 'next/router';
import { ArrowRight, Coins, FileInput } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';

interface AddSourceDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Lets the operator pick which rail to add a source for, then hands off to that
 * rail's guided setup screen. Both rails own their own multi-step wizard
 * (`/setup` for Cardano, `/x402-setup` for x402/EVM), so this dialog only
 * routes — it never embeds an add form of its own.
 */
export function AddSourceDialog({ open, onClose }: AddSourceDialogProps) {
  const router = useRouter();
  const { network } = useAppContext();

  const go = (path: string) => {
    onClose();
    router.push(`${path}?network=${network}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a payment source</DialogTitle>
          <DialogDescription>
            Choose the rail to configure. Each opens a short guided setup for {network}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <RailOption
            icon={<FileInput className="h-5 w-5" />}
            iconClassName="bg-sky-500/15 text-sky-600 ring-sky-500/30 dark:text-sky-400"
            title="Cardano"
            description="Escrow payment source with managed wallets and an admin quorum."
            onClick={() => go('/setup')}
          />
          <RailOption
            icon={<Coins className="h-5 w-5" />}
            iconClassName="bg-indigo-500/15 text-indigo-600 ring-indigo-500/30 dark:text-indigo-400"
            title="EVM (x402)"
            description="Stablecoin rail over the x402 standard on a configured EVM chain."
            onClick={() => go('/x402-setup')}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RailOption({
  icon,
  iconClassName,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  iconClassName: string;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-lg ring-1',
            iconClassName,
          )}
        >
          {icon}
        </span>
        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
