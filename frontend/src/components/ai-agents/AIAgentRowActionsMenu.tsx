import { ExternalLink, Info, MoreHorizontal, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type AIAgentRowActionsMenuProps = {
  showVerifyPublish: boolean;
  showUpdateMetadata: boolean;
  showDeleteOrDeregister: boolean;
  deleteLabel: string;
  onVerifyPublish: () => void;
  onViewDetails: () => void;
  onViewEarnings: () => void;
  onUpdateMetadata: () => void;
  onDeleteOrDeregister: () => void;
};

export function AIAgentRowActionsMenu({
  showVerifyPublish,
  showUpdateMetadata,
  showDeleteOrDeregister,
  deleteLabel,
  onVerifyPublish,
  onViewDetails,
  onViewEarnings,
  onUpdateMetadata,
  onDeleteOrDeregister,
}: AIAgentRowActionsMenuProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Agent actions"
          className="h-8 w-8"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem className="cursor-pointer gap-2" onSelect={() => onViewDetails()}>
          <Info className="h-4 w-4" />
          View details
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer gap-2" onSelect={() => onViewEarnings()}>
          <ExternalLink className="h-4 w-4" />
          View earnings
        </DropdownMenuItem>
        {showVerifyPublish && (
          <DropdownMenuItem className="cursor-pointer gap-2" onSelect={() => onVerifyPublish()}>
            <ShieldCheck className="h-4 w-4" />
            Verify and publish
          </DropdownMenuItem>
        )}
        {showUpdateMetadata && (
          <DropdownMenuItem className="cursor-pointer gap-2" onSelect={() => onUpdateMetadata()}>
            <Pencil className="h-4 w-4" />
            Update metadata
          </DropdownMenuItem>
        )}
        {showDeleteOrDeregister && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer gap-2 text-destructive focus:text-destructive"
              onSelect={() => onDeleteOrDeregister()}
            >
              <Trash2 className="h-4 w-4" />
              {deleteLabel}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
