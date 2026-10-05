import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';
import { cn, formatAssetAmount, shortenAddress, getExplorerUrl } from '@/lib/utils';
import type { RegistryEntry, PaymentSourceExtended } from '@/lib/api/generated';
import type { AgentRelation } from '@/lib/queries/useContextAgents';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { agentHasX402Options } from './AgentX402Options';
import { agentHasVerifications } from './AgentVerifications';
import { Spinner } from '@/components/ui/spinner';
import { rowActivation } from '@/lib/a11y';
import { isDeregisterableAgentState } from '@/lib/registry-states';
import { FaRegClock } from 'react-icons/fa';
import { CopyButton } from '@/components/ui/copy-button';
import { Separator } from '@/components/ui/separator';
import { TableSelectRowCheckbox } from '@/components/ui/table-select-checkbox';
import { AIAgentRowActionsMenu } from './AIAgentRowActionsMenu';
import {
  tableActionsCellCompactClass,
  tableActionsCellCompactSelectedClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';
import {
  parseAgentStatus,
  getAgentStatusBadgeVariant,
  getAgentStatusHelperText,
  getAgentIdentifierPlaceholder,
} from '@/lib/agent-status';
import { getAgentTypeLabel } from '@/lib/agent-type';
import { canEditAgentMetadata } from '@/lib/can-edit-agent-metadata';
import { formatDate } from '@/lib/format-date';
import { getPrimaryCardanoPricing } from '@/lib/registry-pricing';
export type AIAgent = RegistryEntry & { relation?: AgentRelation };
function RelationBadge({ relation }: { relation?: AgentRelation }) {
  if (relation === 'payment') {
    return (
      <Badge
        variant="outline"
        className="w-fit border-indigo-300 bg-indigo-50 text-[10px] text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300"
      >
        Registered elsewhere
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="w-fit text-[10px]">
      Registered here
    </Badge>
  );
}

type AgentWalletRowProps = {
  label: string;
  address: string;
  walletVkey: string;
  onWalletClick: (walletVkey: string) => void;
  /** Wider preview when minting and holding share one address (single-column layout). */
  variant?: 'split' | 'combined';
};

function AgentWalletRow({
  label,
  address,
  walletVkey,
  onWalletClick,
  variant = 'split',
}: AgentWalletRowProps) {
  const previewChars = variant === 'combined' ? 10 : 4;

  return (
    <div className={cn('min-w-0 space-y-1', variant === 'split' && 'flex-1')}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          className={cn(
            'min-w-0 text-left font-mono text-xs text-muted-foreground hover:text-primary',
            variant === 'combined' ? 'max-w-[14rem] truncate' : 'truncate',
          )}
          title={address}
          onClick={(event) => {
            event.stopPropagation();
            onWalletClick(walletVkey);
          }}
        >
          {shortenAddress(address, previewChars)}
        </button>
        <CopyButton value={address} />
      </div>
    </div>
  );
}

const getHoldingWallet = (agent: AIAgent) => agent.RecipientWallet ?? agent.SmartContractWallet;

const usesCombinedWallet = (agent: AIAgent) =>
  getHoldingWallet(agent).walletVkey === agent.SmartContractWallet.walletVkey;

type AIAgentRowProps = {
  agent: AIAgent;
  index: number;
  network: NetworkType;
  isSelected: boolean;
  showBulkSelection: boolean;
  capabilities: { canPay: boolean; canAdmin: boolean };
  selectedPaymentSource: PaymentSourceExtended | null | undefined;
  onToggleSelection: () => void;
  onSelect: (agent: AIAgent) => void;
  onWalletClick: (walletVkey: string) => void;
  onVerify: (agent: AIAgent) => void;
  onEarnings: (agent: AIAgent) => void;
  onUpdate: (agent: AIAgent) => void;
  onDelete: (agent: AIAgent) => void;
};
export function AIAgentRow({
  agent,
  index,
  network,
  isSelected,
  showBulkSelection,
  capabilities,
  selectedPaymentSource,
  onToggleSelection,
  onSelect,
  onWalletClick,
  onVerify,
  onEarnings,
  onUpdate,
  onDelete,
}: AIAgentRowProps) {
  const holdingWallet = getHoldingWallet(agent);
  const isCombinedWallet = usesCombinedWallet(agent);
  const statusHelperText = getAgentStatusHelperText(agent.state);
  const hasRowActions =
    isDeregisterableAgentState(agent.state) ||
    agent.state === 'RegistrationInitiated' ||
    agent.state === 'DeregistrationInitiated' ||
    agent.state === 'RegistrationRequested' ||
    agent.state === 'DeregistrationRequested';
  const rowIsSelected = isSelected;

  return (
    <tr
      key={agent.id}
      className={cn(
        'group border-b cursor-pointer hover:bg-row-hover opacity-0',
        rowIsSelected && 'bg-row-hover',
        agent.state === 'DeregistrationConfirmed' ? 'animate-fade-in-to-muted' : 'animate-fade-in',
      )}
      style={{
        animationDelay: `${Math.min(index, 9) * 40}ms`,
      }}
      aria-label={`View details for ${agent.name}`}
      onClick={() => onSelect(agent)}
      {...rowActivation(() => onSelect(agent))}
    >
      {showBulkSelection && (
        <td className="p-4" onClick={(event) => event.stopPropagation()}>
          <TableSelectRowCheckbox
            aria-label={`Select ${agent.name}`}
            checked={rowIsSelected}
            onToggle={() => onToggleSelection()}
          />
        </td>
      )}
      <td className={cn('p-4 max-w-50 truncate', !showBulkSelection && 'pl-6')}>
        <div className="text-sm font-medium truncate" title={agent.name}>
          {agent.name}
        </div>
        <div
          className="text-xs text-muted-foreground truncate"
          title={agent.description ?? undefined}
        >
          {agent.description}
        </div>
      </td>
      <td className="p-4">
        {/* Neutral outline: Status is the only colour-bearing
                                badge in the row, and the Wallets cell already
                                carries a RelationBadge. */}
        <Badge variant="outline" className="whitespace-nowrap">
          {getAgentTypeLabel(agent.type)}
        </Badge>
      </td>
      <td className="p-4 text-sm">{formatDate(agent.createdAt)}</td>
      <td className="p-4">
        {agent.agentIdentifier ? (
          <div className="text-xs font-mono truncate max-w-50 flex items-center gap-2">
            <a
              href={getExplorerUrl(agent.agentIdentifier, network, 'token')}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-primary hover:underline flex items-center gap-1 truncate"
            >
              {shortenAddress(agent.agentIdentifier)}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            <CopyButton value={agent.agentIdentifier} />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {getAgentIdentifierPlaceholder(agent.state)}
          </span>
        )}
      </td>
      <td className="p-4 align-top">
        <div className={cn('space-y-2', isCombinedWallet ? 'w-fit max-w-md' : 'min-w-[15rem]')}>
          <RelationBadge relation={agent.relation} />
          <div
            className={cn(
              'rounded-md border bg-muted/10 p-2.5',
              isCombinedWallet && 'w-fit max-w-full',
            )}
          >
            {isCombinedWallet ? (
              <AgentWalletRow
                variant="combined"
                label="Minting & holding"
                address={holdingWallet.walletAddress}
                walletVkey={holdingWallet.walletVkey}
                onWalletClick={onWalletClick}
              />
            ) : (
              <div className="flex items-stretch gap-3">
                <AgentWalletRow
                  label="Minting"
                  address={agent.SmartContractWallet.walletAddress}
                  walletVkey={agent.SmartContractWallet.walletVkey}
                  onWalletClick={onWalletClick}
                />
                <Separator orientation="vertical" className="h-auto" />
                <AgentWalletRow
                  label="Holding"
                  address={holdingWallet.walletAddress}
                  walletVkey={holdingWallet.walletVkey}
                  onWalletClick={onWalletClick}
                />
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="p-4 text-sm truncate max-w-25">
        {(() => {
          const pricing = getPrimaryCardanoPricing(agent);
          if (pricing?.pricingType === 'Free') {
            return <div className="whitespace-nowrap">Free</div>;
          }
          if (pricing?.pricingType === 'Dynamic') {
            return <div className="whitespace-nowrap">Dynamic</div>;
          }
          if (pricing?.pricingType === 'Fixed') {
            return pricing.Pricing.map((price, index) => (
              <div key={index} className="whitespace-nowrap">
                {formatAssetAmount(price.amount, price.unit, network)}
              </div>
            ));
          }
          return null;
        })()}
        {agentHasX402Options(agent.supportedPaymentSources) && (
          <div className="mt-1">
            <Badge variant="secondary">x402</Badge>
          </div>
        )}
        {agentHasVerifications(agent.verifications) && (
          <div className="mt-1">
            <Badge variant="outline">Verifiable</Badge>
          </div>
        )}
      </td>
      <td className="p-4">
        {agent.Tags.length > 0 && (
          <Badge variant="secondary" className="truncate">
            {agent.Tags.length} tags
          </Badge>
        )}
      </td>
      <td className="p-4">
        <div className="space-y-1">
          <Badge variant={getAgentStatusBadgeVariant(agent.state)}>
            {parseAgentStatus(agent.state)}
          </Badge>
          {statusHelperText && (
            <p className="text-xs text-muted-foreground max-w-48 truncate" title={statusHelperText}>
              {statusHelperText}
            </p>
          )}
        </div>
      </td>
      <td
        className={cn(
          rowIsSelected ? tableActionsCellCompactSelectedClass : tableActionsCellCompactClass,
          !hasRowActions && 'pointer-events-none',
        )}
        onClick={hasRowActions ? (event) => event.stopPropagation() : undefined}
      >
        <div className={tableActionsInnerClass}>
          {isDeregisterableAgentState(agent.state) ? (
            <AIAgentRowActionsMenu
              showVerifyPublish={agent.relation !== 'payment'}
              showUpdateMetadata={canEditAgentMetadata({
                agent,
                relation: agent.relation,
                canPay: capabilities.canPay,
                selectedPaymentSource,
              })}
              showDeleteOrDeregister={
                agent.relation !== 'payment' &&
                (agent.state === 'RegistrationFailed' || agent.state === 'DeregistrationConfirmed'
                  ? capabilities.canAdmin
                  : capabilities.canPay)
              }
              deleteLabel={
                agent.state === 'RegistrationFailed' || agent.state === 'DeregistrationConfirmed'
                  ? 'Delete agent'
                  : 'Deregister agent'
              }
              onVerifyPublish={() => onVerify(agent)}
              onViewDetails={() => onSelect(agent)}
              onViewEarnings={() => onEarnings(agent)}
              onUpdateMetadata={() => onUpdate(agent)}
              onDeleteOrDeregister={() => onDelete(agent)}
            />
          ) : agent.state === 'RegistrationInitiated' ||
            agent.state === 'DeregistrationInitiated' ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="text-primary"
              title="Processing on-chain"
            >
              <Spinner size={16} />
            </Button>
          ) : (
            (agent.state === 'RegistrationRequested' ||
              agent.state === 'DeregistrationRequested') && (
              <Button
                variant="ghost"
                size="sm"
                disabled
                className="text-primary"
                title={getAgentStatusHelperText(agent.state) ?? 'Pending'}
              >
                <FaRegClock />
              </Button>
            )
          )}
        </div>
      </td>
    </tr>
  );
}
