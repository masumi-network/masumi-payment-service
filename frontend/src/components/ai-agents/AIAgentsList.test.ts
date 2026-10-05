import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import { AIAgentsList } from './AIAgentsList';
import { AIAgentTableSkeleton } from '@/components/skeletons/AIAgentTableSkeleton';
import { SelectItem } from '@/components/ui/select';

const noop = () => {};
const props: ComponentProps<typeof AIAgentsList> = {
  children: 'rows',
  activeRail: 'cardano',
  capabilities: { canPay: true, canAdmin: true },
  canMigrate: true,
  isFetchingAgents: false,
  refetchAll: noop,
  onMigrate: noop,
  onRegister: noop,
  tabs: [],
  activeTab: 'All',
  onTabChange: noop,
  searchQuery: '',
  onSearchChange: noop,
  isSearchPending: false,
  typeFilter: 'All',
  onTypeFilterChange: noop,
  truncated: false,
  isLoading: false,
  agentCount: 1,
  displayAgentCount: 1,
  showBulkSelection: false,
  selectedCount: 0,
  clearSelection: noop,
  isBulkActionBusy: false,
  isDeleting: false,
  openBulkDeregisterConfirm: noop,
  openBulkDeleteConfirm: noop,
  deregisterableCount: 0,
  deletableCount: 0,
  allSelected: false,
  someSelected: false,
  toggleAll: noop,
  visibleRowCount: 1,
  tableColumnCount: 9,
};
type ElementProps = {
  children?: ReactNode;
  value?: string;
  columns?: number;
  withSelectionColumn?: boolean;
};
function elements(node: ReactNode): Array<{ type: unknown; props: ElementProps }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

test('extracted list includes A2A filter and keeps loading column count', () => {
  const loaded = elements(AIAgentsList(props));
  assert.ok(loaded.some((element) => element.type === SelectItem && element.props.value === 'A2A'));
  assert.ok(!loaded.some((element) => element.type === AIAgentTableSkeleton));
  const loading = elements(
    AIAgentsList({
      ...props,
      isLoading: true,
      agentCount: 0,
      tableColumnCount: 10,
      showBulkSelection: true,
    }),
  );
  const skeleton = loading.find((element) => element.type === AIAgentTableSkeleton);
  assert.equal(skeleton?.props.columns, 10);
  assert.equal(skeleton?.props.withSelectionColumn, true);
});
