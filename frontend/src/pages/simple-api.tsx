import { useState, useMemo, useCallback } from 'react';
import Head from 'next/head';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import { AnimatedPage } from '@/components/ui/animated-page';
import { SearchInput } from '@/components/ui/search-input';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleApiCard } from '@/components/simple-api/SimpleApiCard';
import { SimpleApiCardSkeleton } from '@/components/skeletons/SimpleApiCardSkeleton';
import { SimpleApiDetailsDialog } from '@/components/simple-api/SimpleApiDetailsDialog';
import { RegisterSimpleApiDialog } from '@/components/simple-api/RegisterSimpleApiDialog';
import { useSimpleApiListings, SimpleApiStatusFilter } from '@/lib/queries/useSimpleApiListings';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';
import { SimpleApiListing } from '@/lib/api/generated';

const CATEGORIES = [
  'All',
  'Inference',
  'Data',
  'Media',
  'Search',
  'Social',
  'Infrastructure',
  'Trading',
  'Other',
];

const STATUS_TABS = [
  { name: 'All', count: null },
  { name: 'Online', count: null },
  { name: 'Offline', count: null },
  { name: 'Invalid', count: null },
  { name: 'Deregistered', count: null },
];

export default function SimpleApiPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery);
  const [activeTab, setActiveTab] = useState('All');
  const [activeCategory, setActiveCategory] = useState('All');
  const [selectedListing, setSelectedListing] = useState<SimpleApiListing | null>(null);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);

  const filterStatus = useMemo((): SimpleApiStatusFilter | undefined => {
    if (activeTab === 'All') return undefined;
    return activeTab as SimpleApiStatusFilter;
  }, [activeTab]);

  const { listings, isLoading, isFetching, isPlaceholderData, hasMore, refetch, loadMore } =
    useSimpleApiListings({
      filterStatus,
      searchQuery: debouncedSearch || undefined,
    });

  const isSearchPending = searchQuery !== debouncedSearch || (isFetching && isPlaceholderData);

  // Client-side category filter (category is not a backend query param)
  const displayListings = useMemo(() => {
    if (activeCategory === 'All') return listings;
    return listings.filter((l) => l.category?.toLowerCase() === activeCategory.toLowerCase());
  }, [listings, activeCategory]);

  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const isInitialLoading = isLoading && !listings.length;

  return (
    <MainLayout>
      <Head>
        <title>Simple API Services | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Simple API Services</h1>
              <p className="text-sm text-muted-foreground">
                Browse and manage x402-gated API services synced from the registry.{' '}
                <a
                  href="https://agentic.market"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton onRefresh={handleRefresh} isRefreshing={isFetching} />
              <Button
                className="flex items-center gap-2 btn-hover-lift"
                onClick={() => setIsRegisterOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Register Service
              </Button>
            </div>
          </div>

          {/* Status tabs */}
          <Tabs
            tabs={STATUS_TABS}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
            }}
          />

          {/* Search + category filters */}
          <div className="space-y-3">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search by name, URL, category, tags…"
              className="max-w-sm"
              isLoading={isSearchPending && !!searchQuery}
            />

            {/* Category chip filter */}
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={cn(
                    'text-xs px-3 py-1.5 rounded-full border transition-colors',
                    activeCategory === cat
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground',
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Card grid */}
          {isInitialLoading || (displayListings.length === 0 && isSearchPending) ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              <SimpleApiCardSkeleton count={6} />
            </div>
          ) : displayListings.length === 0 ? (
            <EmptyState
              icon={searchQuery || activeCategory !== 'All' ? 'search' : 'inbox'}
              title={
                searchQuery
                  ? 'No services found matching your search'
                  : activeCategory !== 'All'
                    ? `No services found in "${activeCategory}"`
                    : 'No Simple API services found'
              }
              description={
                searchQuery
                  ? 'Try adjusting your search or category filter'
                  : 'Register your first x402-gated service to get started'
              }
              action={
                !searchQuery && activeCategory === 'All' ? (
                  <Button variant="outline" size="sm" onClick={() => setIsRegisterOpen(true)}>
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    Register Service
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div
              className={cn(
                'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 transition-opacity duration-150',
                isSearchPending && 'opacity-70',
              )}
            >
              {displayListings.map((listing) => (
                <SimpleApiCard key={listing.id} listing={listing} onDetails={setSelectedListing} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {!isInitialLoading && (
            <div className="flex justify-center">
              <Pagination
                hasMore={hasMore}
                isLoading={isFetching && !!listings.length}
                onLoadMore={loadMore}
              />
            </div>
          )}
        </div>

        <SimpleApiDetailsDialog
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
        />

        <RegisterSimpleApiDialog
          open={isRegisterOpen}
          onClose={() => setIsRegisterOpen(false)}
          onSuccess={() => {
            setTimeout(() => void refetch(), 500);
          }}
        />
      </AnimatedPage>
    </MainLayout>
  );
}
