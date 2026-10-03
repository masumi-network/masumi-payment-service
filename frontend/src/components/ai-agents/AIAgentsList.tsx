import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, ArrowUpRight, Trash2, Unlink } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { MASUMI_AGENTS_DOCS_URL } from '@/lib/masumi-links';
import { cn } from '@/lib/utils';
import { Tabs } from '@/components/ui/tabs';
import { SearchInput } from '@/components/ui/search-input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AGENT_TYPE_LABELS } from '@/lib/agent-type';
import { BulkActionBar } from '@/components/ui/bulk-action-bar';
import { HorizontalScrollArea } from '@/components/ui/horizontal-scroll-area';
import { TableSelectAllCheckbox } from '@/components/ui/table-select-checkbox';
import { tableActionsHeadCompactClass } from '@/components/ui/table-actions-column';
import { AIAgentTableSkeleton } from '@/components/skeletons/AIAgentTableSkeleton';
import { EmptyState } from '@/components/ui/empty-state';
import type { ComponentProps } from 'react';
type ListProps = {
  children: ReactNode;
  activeRail: string;
  capabilities: { canPay: boolean; canAdmin: boolean };
  canMigrate: boolean;
  isFetchingAgents: boolean;
  refetchAll: () => void;
  onMigrate: () => void;
  onRegister: () => void;
  tabs: ComponentProps<typeof Tabs>['tabs'];
  activeTab: string;
  onTabChange: (tab: string) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  isSearchPending: boolean;
  typeFilter: string;
  onTypeFilterChange: (value: string) => void;
  truncated: boolean;
  isLoading: boolean;
  agentCount: number;
  displayAgentCount: number;
  showBulkSelection: boolean;
  selectedCount: number;
  clearSelection: () => void;
  isBulkActionBusy: boolean;
  isDeleting: boolean;
  openBulkDeregisterConfirm: () => void;
  openBulkDeleteConfirm: () => void;
  deregisterableCount: number;
  deletableCount: number;
  allSelected: boolean;
  someSelected: boolean;
  toggleAll: () => void;
  visibleRowCount: number;
  tableColumnCount: number;
};
export function AIAgentsList({
  children,
  activeRail,
  capabilities,
  canMigrate,
  isFetchingAgents,
  refetchAll,
  onMigrate,
  onRegister,
  tabs,
  activeTab,
  onTabChange,
  searchQuery,
  onSearchChange,
  isSearchPending,
  typeFilter,
  onTypeFilterChange,
  truncated,
  isLoading,
  agentCount,
  displayAgentCount,
  showBulkSelection,
  selectedCount,
  clearSelection,
  isBulkActionBusy,
  isDeleting,
  openBulkDeregisterConfirm,
  openBulkDeleteConfirm,
  deregisterableCount,
  deletableCount,
  allSelected,
  someSelected,
  toggleAll,
  visibleRowCount,
  tableColumnCount,
}: ListProps) {
  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI agents</h1>
          <p className="text-sm text-muted-foreground">
            Manage your AI agents and their configurations.{' '}
            <a
              href={MASUMI_AGENTS_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Learn more
            </a>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            onRefresh={() => {
              refetchAll();
            }}
            isRefreshing={isFetchingAgents}
          />
          {/* Registration and migration are Cardano-registry operations. On the x402
                  rail this page is a read-only "accepts x402" view, so these don't apply. */}
          {activeRail === 'cardano' && capabilities.canPay && canMigrate && (
            <Button
              variant="outline"
              className="flex items-center gap-2 btn-hover-lift"
              onClick={() => onMigrate()}
            >
              <ArrowUpRight className="h-4 w-4" />
              Migrate to V2
            </Button>
          )}
          {activeRail === 'cardano' && capabilities.canPay && (
            <Button className="flex items-center gap-2 btn-hover-lift" onClick={() => onRegister()}>
              <Plus className="h-4 w-4" />
              Register AI Agent
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-6">
        <Tabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={(tab) => {
            onTabChange(tab);
          }}
        />

        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 max-w-xs">
            <SearchInput
              value={searchQuery}
              onChange={(value) => {
                onSearchChange(value);
              }}
              placeholder="Search by name, description, tags, or wallet..."
              isLoading={isSearchPending && !!searchQuery}
            />
          </div>
          <Select
            value={typeFilter}
            onValueChange={(value) => {
              onTypeFilterChange(value);
            }}
          >
            <SelectTrigger className="w-[140px]" aria-label="Filter agents by type">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="All">All types</SelectItem>
                {/* Options come from the same label map as the Type column, so
                        the filter can never disagree with the badges it filters. */}
                {Object.entries(AGENT_TYPE_LABELS).map(([type, label]) => (
                  <SelectItem key={type} value={type}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {truncated && !isLoading && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
            Showing the first {agentCount} agents. The list is capped, so some entries may not
            appear. Use search or the status filter to narrow down to a specific agent.
          </div>
        )}

        {showBulkSelection && (
          <BulkActionBar
            selectedCount={selectedCount}
            onClear={clearSelection}
            disabled={isBulkActionBusy || isDeleting}
          >
            {capabilities.canPay && (
              <Button
                variant="outline"
                size="sm"
                onClick={openBulkDeregisterConfirm}
                disabled={isBulkActionBusy || isDeleting || deregisterableCount === 0}
              >
                <Unlink className="h-4 w-4" />
                Deregister ({deregisterableCount})
              </Button>
            )}
            {capabilities.canAdmin && (
              <Button
                variant="destructive"
                size="sm"
                onClick={openBulkDeleteConfirm}
                disabled={isBulkActionBusy || isDeleting || deletableCount === 0}
              >
                <Trash2 className="h-4 w-4" />
                Delete ({deletableCount})
              </Button>
            )}
          </BulkActionBar>
        )}

        <HorizontalScrollArea className="rounded-lg border">
          <table
            className={cn(
              'w-full transition-opacity duration-150',
              isSearchPending && 'opacity-70',
            )}
          >
            <thead className="table-header-surface">
              <tr className="border-b">
                {showBulkSelection && (
                  <th scope="col" className="w-12 p-4">
                    <TableSelectAllCheckbox
                      allSelected={allSelected}
                      someSelected={someSelected}
                      onToggleAll={toggleAll}
                      disabled={visibleRowCount === 0}
                      aria-label="Select all agents on this page"
                    />
                  </th>
                )}
                <th
                  scope="col"
                  className={cn(
                    'p-4 text-left text-sm font-medium text-muted-foreground',
                    !showBulkSelection && 'pl-6',
                  )}
                >
                  Name
                </th>
                <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                  Type
                </th>
                <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                  Added
                </th>
                <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                  Agent ID
                </th>
                <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                  Wallets
                </th>
                <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                  Price
                </th>
                <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                  Tags
                </th>
                <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                  Status
                </th>
                <th scope="col" className={tableActionsHeadCompactClass}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {(isLoading && !agentCount) || (displayAgentCount === 0 && isSearchPending) ? (
                <AIAgentTableSkeleton rows={5} columns={tableColumnCount} />
              ) : displayAgentCount === 0 ? (
                <tr>
                  <td colSpan={tableColumnCount}>
                    <EmptyState
                      icon={searchQuery ? 'search' : 'inbox'}
                      title={
                        searchQuery
                          ? 'No AI agents found matching your search'
                          : activeRail === 'x402'
                            ? 'No agents accept x402 payment here'
                            : 'No AI agents found'
                      }
                      description={
                        searchQuery
                          ? 'Try adjusting your search terms'
                          : activeRail === 'x402'
                            ? "Agents that accept x402 on this environment's chains will appear here."
                            : capabilities.canPay
                              ? 'Register your first AI agent to get started'
                              : 'Registering an agent needs an API key with pay access'
                      }
                    />
                  </td>
                </tr>
              ) : (
                children
              )}
            </tbody>
          </table>
        </HorizontalScrollArea>
      </div>
    </>
  );
}
