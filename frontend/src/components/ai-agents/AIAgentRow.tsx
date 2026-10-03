import { supportsAgentMetadataUpdate } from '@/lib/agent-update';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Pencil, Trash2, ExternalLink, ShieldCheck } from 'lucide-react';
import { cn, formatAssetAmount, shortenAddress, getExplorerUrl } from '@/lib/utils';
import type { RegistryEntry } from '@/lib/api/generated';
import type { NetworkType } from '@/lib/contexts/AppContext';
import type { AgentRelation } from '@/lib/queries/useContextAgents';
import { agentHasX402Options } from './AgentX402Options';
import { agentHasVerifications } from './AgentVerifications';
import { Spinner } from '@/components/ui/spinner';
import { rowActivation } from '@/lib/a11y';
import { isDeregisterableAgentState } from '@/lib/registry-states';
import { FaRegClock } from 'react-icons/fa';
import { CopyButton } from '@/components/ui/copy-button';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { parseAgentStatus, getAgentStatusBadgeVariant } from '@/lib/agent-status';
import { formatDate } from '@/lib/format-date';
import { getPrimaryCardanoPricing } from '@/lib/registry-pricing';
export type AIAgent = RegistryEntry & { relation?: AgentRelation };
// Tells apart agents registered on the active source from those registered elsewhere that
// merely accept payment on it (or over x402 on an EVM chain).
function RelationBadge({ relation }: { relation?: AgentRelation }) {
  if (relation === 'payment') {
    return (
      <Badge
        variant="outline"
        className="mt-1 border-indigo-300 bg-indigo-50 text-[10px] text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300"
      >
        Registered elsewhere
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="mt-1 text-[10px]">
      Registered here
    </Badge>
  );
}

const getHoldingWallet = (agent: AIAgent) => agent.RecipientWallet ?? agent.SmartContractWallet;

const usesCombinedWallet = (agent: AIAgent) =>
  getHoldingWallet(agent).walletVkey === agent.SmartContractWallet.walletVkey;

type AIAgentRowProps = {
  agent: AIAgent;
  index: number;
  network: NetworkType;
  isV2Source: boolean;
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
  isV2Source,
  onSelect,
  onWalletClick,
  onVerify,
  onEarnings,
  onUpdate,
  onDelete,
}: AIAgentRowProps) {
  const holdingWallet = getHoldingWallet(agent);
  const isCombinedWallet = usesCombinedWallet(agent);
  return (
    <tr
      key={agent.id}
      className={cn(
        'border-b cursor-pointer hover:bg-muted/50 transition-[background-color,opacity] duration-150 opacity-0',
        agent.state === 'DeregistrationConfirmed' ? 'animate-fade-in-to-muted' : 'animate-fade-in',
      )}
      style={{
        animationDelay: `${Math.min(index, 9) * 40}ms`,
      }}
      aria-label={`View details for ${agent.name}`}
      onClick={() => onSelect(agent)}
      {...rowActivation(() => onSelect(agent))}
    >
      <td className="p-4 max-w-50 truncate pl-6">
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
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="p-4">
        <PaymentSourceTypeBadge paymentSourceType={agent.paymentSourceType} />
      </td>
      <td className="p-4">
        <div className="space-y-2">
          <RelationBadge relation={agent.relation} />
          {isCombinedWallet ? (
            <div>
              <div className="text-xs font-medium">Minting & holding wallet</div>
              <div className="text-xs text-muted-foreground font-mono truncate max-w-50 flex items-center gap-2">
                <span
                  className="cursor-pointer hover:text-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    onWalletClick(holdingWallet.walletVkey);
                  }}
                >
                  {shortenAddress(holdingWallet.walletAddress)}
                </span>
                <CopyButton value={holdingWallet.walletAddress} />
              </div>
            </div>
          ) : (
            <>
              <div>
                <div className="text-xs font-medium">Minting wallet</div>
                <div className="text-xs text-muted-foreground font-mono truncate max-w-50 flex items-center gap-2">
                  <span
                    className="cursor-pointer hover:text-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onWalletClick(agent.SmartContractWallet.walletVkey);
                    }}
                  >
                    {shortenAddress(agent.SmartContractWallet.walletAddress)}
                  </span>
                  <CopyButton value={agent.SmartContractWallet.walletAddress} />
                </div>
              </div>
              <div>
                <div className="text-xs font-medium">Holding wallet</div>
                <div className="text-xs text-muted-foreground font-mono truncate max-w-50 flex items-center gap-2">
                  <span
                    className="cursor-pointer hover:text-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onWalletClick(holdingWallet.walletVkey);
                    }}
                  >
                    {shortenAddress(holdingWallet.walletAddress)}
                  </span>
                  <CopyButton value={holdingWallet.walletAddress} />
                </div>
              </div>
            </>
          )}
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
        <Badge variant={getAgentStatusBadgeVariant(agent.state)}>
          {parseAgentStatus(agent.state)}
        </Badge>
      </td>
      <td className="p-4 pr-8">
        {isDeregisterableAgentState(agent.state) ? (
          <div className="flex items-center gap-1">
            {/* Manage actions (verify/update/delete) only apply to agents
                                    registered on the active source. Agents shown because they
                                    accept payment here are managed from their home source. */}
            {agent.relation !== 'payment' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onVerify(agent);
                }}
                className="text-primary hover:text-primary hover:bg-primary/10"
                title="Verify and Publish"
              >
                <ShieldCheck className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onEarnings(agent);
              }}
              className="text-white hover:text-gray-200 hover:bg-gray-600"
              title="View Details & Earnings"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            {agent.relation !== 'payment' && supportsAgentMetadataUpdate(agent) && isV2Source && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate(agent);
                }}
                className="text-primary hover:text-primary hover:bg-primary/10"
                title="Update agent metadata (V2)"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {agent.relation !== 'payment' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(agent);
                }}
                className="text-destructive hover:text-destructive hover:bg-destructive/10 group"
              >
                <Trash2 className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
              </Button>
            )}
          </div>
        ) : agent.state === 'RegistrationInitiated' || agent.state === 'DeregistrationInitiated' ? (
          <div className="flex items-center justify-center w-8 h-8">
            <Spinner size={16} />
          </div>
        ) : (
          (agent.state === 'RegistrationRequested' ||
            agent.state === 'DeregistrationRequested') && (
            <div className="flex items-center justify-center w-8 h-8">
              <FaRegClock size={12} />
            </div>
          )
        )}
      </td>
    </tr>
  );
}
