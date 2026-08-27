/**
 * Invites, one click away from the heads table.
 *
 * They used to be a full-width card stacked above the table, and are not read
 * often enough to earn that: an invite is issued occasionally and the table is
 * read constantly. Moving them behind a dialog is progressive disclosure rather
 * than hiding — the count stays visible in the context bar, which is also what
 * opens this.
 *
 * Nodes had a matching dialog and card here. Both went: the node strip and
 * `HydraNodeDetailsDialog` took over every action they offered, and nothing had
 * rendered either of them since, so their controls — connecting a second node,
 * and editing a connection — could not be reached at all.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HydraInvitesCard } from '@/components/hydra/HydraInvitesCard';

type ManageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

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
