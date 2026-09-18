import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';
import { useSearch, SearchableItem } from '@/lib/hooks/useSearch';
import {
  Bell,
  Bot,
  FileText,
  GitBranch,
  Key,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Settings,
  Wallet,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SEARCH_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  'ai-agents': Bot,
  'inbox-agents': MessageSquare,
  wallets: Wallet,
  transactions: FileText,
  'payment-sources': GitBranch,
  'api-keys': Key,
  webhooks: Bell,
  settings: Settings,
  'add-ai-agent': Plus,
  'add-inbox-agent': Plus,
  'add-wallet': Plus,
  'add-payment-source': Plus,
  'add-api-key': Plus,
  'add-webhook': Plus,
  'toggle-theme': Wand2,
  notifications: Bell,
  'incoming-transactions': FileText,
  'outgoing-transactions': FileText,
};

const GROUP_HEADINGS: Record<SearchableItem['type'], string> = {
  page: 'Navigation',
  action: 'Quick actions',
  wallet: 'Wallets',
  agent: 'Agents',
  'payment-source': 'Payment sources',
  transaction: 'Transactions',
};

const GROUP_ORDER: SearchableItem['type'][] = [
  'agent',
  'page',
  'action',
  'wallet',
  'payment-source',
  'transaction',
];

function SearchResultItem({
  result,
  onSelect,
}: {
  result: SearchableItem;
  onSelect: (result: SearchableItem) => void;
}) {
  const Icon =
    result.type === 'agent'
      ? Bot
      : (SEARCH_ICONS[result.id] ?? (result.type === 'page' ? LayoutDashboard : Plus));

  return (
    <CommandItem
      key={result.id}
      value={`${result.id} ${result.title} ${result.description ?? ''}`}
      keywords={result.keywords}
      onSelect={() => onSelect(result)}
    >
      <Icon className="mr-2 h-4 w-4 shrink-0 opacity-70" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span className="truncate">{result.title}</span>
        {result.description ? (
          <span className="text-muted-foreground w-full truncate text-xs">
            {result.description}
          </span>
        ) : null}
      </div>
    </CommandItem>
  );
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const router = useRouter();
  const { openAgentDetails } = useAgentDetailsDialog();
  const [searchQuery, setSearchQuery] = useState('');
  const { searchResults, isWalletsLoading } = useSearch(open, searchQuery);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSearchQuery('');
    }
    onOpenChange(nextOpen);
  };

  const handleSearchSelect = (result: SearchableItem) => {
    handleOpenChange(false);

    if (result.type === 'agent' && result.registryEntry) {
      openAgentDetails(result.registryEntry, { initialTab: 'Details' });
      if (router.pathname !== '/ai-agents') {
        void router.push('/ai-agents');
      }
      return;
    }

    router.push(result.href).then(() => {
      if (result.elementId) {
        setTimeout(() => {
          const element = document.getElementById(result.elementId || '');
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('highlight-element');
            setTimeout(() => {
              element.classList.remove('highlight-element');
            }, 4000);
          }
        }, 100);
      }
    });
  };

  const trimmedQuery = searchQuery.trim();

  const groupedResults = useMemo(() => {
    const groups = new Map<SearchableItem['type'], SearchableItem[]>();
    for (const item of searchResults) {
      const list = groups.get(item.type) ?? [];
      list.push(item);
      groups.set(item.type, list);
    }
    return GROUP_ORDER.filter((type) => groups.has(type)).map((type) => ({
      type,
      heading: GROUP_HEADINGS[type],
      items: groups.get(type) ?? [],
    }));
  }, [searchResults]);

  const showEmpty = !isWalletsLoading && trimmedQuery.length > 0 && searchResults.length === 0;

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange} shouldFilter={false}>
      <CommandInput
        placeholder="Search pages, agents, wallets…"
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList>
        {showEmpty ? <CommandEmpty>No results found.</CommandEmpty> : null}
        {groupedResults.map((group, index) => (
          <div key={group.type}>
            {index > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={group.heading}>
              {group.items.map((result) => (
                <SearchResultItem key={result.id} result={result} onSelect={handleSearchSelect} />
              ))}
            </CommandGroup>
          </div>
        ))}
        {isWalletsLoading ? (
          <div className="text-muted-foreground px-3 py-2 text-xs">Searching…</div>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
