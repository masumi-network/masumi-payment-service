/**
 * Nodes and invites, one click away from the heads table.
 *
 * Both used to be full-width cards stacked above the table. Neither is read
 * often enough to earn that: a node is connected once, an invite is issued
 * occasionally, and the table is read constantly. Moving them behind a dialog
 * is progressive disclosure rather than hiding — the counts stay visible in the
 * context bar, which is also what opens this.
 *
 * Deliberately reuses the existing cards rather than reimplementing them: the
 * change here is where they live, not what they do.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HydraNodesCard } from '@/components/hydra/HydraNodesCard';
import { HydraInvitesCard } from '@/components/hydra/HydraInvitesCard';

type ManageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function HydraNodesDialog({ open, onOpenChange }: ManageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connected nodes</DialogTitle>
          <DialogDescription>
            Each node runs one hydra-node process per head and generates that node&apos;s keys
            itself.
          </DialogDescription>
        </DialogHeader>
        <HydraNodesCard variant="embedded" />
      </DialogContent>
    </Dialog>
  );
}

export function HydraInvitesDialog({
  open,
  onOpenChange,
  hasConnectedNode,
}: ManageDialogProps & { hasConnectedNode: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Invites</DialogTitle>
          <DialogDescription>
            A head is opened by issuing an invite or redeeming one. An outstanding invite holds a
            node and a peer port until it is used.
          </DialogDescription>
        </DialogHeader>
        <HydraInvitesCard hasConnectedNode={hasConnectedNode} variant="embedded" />
      </DialogContent>
    </Dialog>
  );
}
