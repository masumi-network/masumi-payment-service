import { useState, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { cn, shortenAddress, formatFundUnit } from '@/lib/utils';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import { InvoiceTableSkeleton } from '@/components/skeletons/InvoiceTableSkeleton';
import { Spinner } from '@/components/ui/spinner';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import { Badge } from '@/components/ui/badge';
import { AnimatedPage } from '@/components/ui/animated-page';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState } from '@/components/ui/empty-state';
import { MonthPicker } from '@/components/ui/month-picker';
import { useInvoices, type InvoiceSummary } from '@/lib/hooks/useInvoices';
import { useUninvoicedPayments, type UninvoicedPayment } from '@/lib/hooks/useUninvoicedPayments';
import { InvoiceDetailsDialog } from '@/components/invoices/InvoiceDetailsDialog';
import { GenerateInvoiceDialog } from '@/components/invoices/GenerateInvoiceDialog';

function getPreviousMonth(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(month: string): string {
  const [yearStr, monthStr] = month.split('-');
  const d = new Date(Number(yearStr), Number(monthStr) - 1, 1);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

interface WalletGroup {
  sellerWalletVkey: string;
  sellerWalletAddress: string | null;
  buyerWalletVkey: string;
  buyerWalletAddress: string | null;
  payments: UninvoicedPayment[];
  totalFunds: Record<string, bigint>;
}

function groupBySellerBuyer(payments: UninvoicedPayment[]): WalletGroup[] {
  const map = new Map<string, WalletGroup>();
  for (const p of payments) {
    const sellerVkey = p.sellerWalletVkey || 'unknown';
    const buyerVkey = p.buyerWalletVkey || 'unknown';
    const key = `${sellerVkey}::${buyerVkey}`;
    let group = map.get(key);
    if (!group) {
      group = {
        sellerWalletVkey: sellerVkey,
        sellerWalletAddress: p.sellerWalletAddress,
        buyerWalletVkey: buyerVkey,
        buyerWalletAddress: p.buyerWalletAddress,
        payments: [],
        totalFunds: {},
      };
      map.set(key, group);
    }
    group.payments.push(p);
    for (const fund of p.RequestedFunds) {
      const prev = group.totalFunds[fund.unit] ?? BigInt(0);
      group.totalFunds[fund.unit] = prev + BigInt(fund.amount);
    }
  }
  return Array.from(map.values());
}

const getStatusColor = (status: string | null) => {
  switch (status?.toLowerCase()) {
    case 'fundslocked':
      return 'text-yellow-500';
    case 'withdrawn':
    case 'resultsubmitted':
      return 'text-green-500';
    case 'refundrequested':
      return 'text-orange-500';
    case 'refundwithdrawn':
      return 'text-blue-500';
    case 'disputed':
    case 'disputedwithdrawn':
      return 'text-red-500';
    default:
      return 'text-muted-foreground';
  }
};

const formatStatus = (status: string | null) => {
  if (!status) return '—';
  return status.replace(/([A-Z])/g, ' $1').trim();
};

const formatPrice = (amount: string) => {
  const numericAmount = parseInt(amount) / 1000000;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(numericAmount);
};

export default function Invoices() {
  const { apiClient, network } = useAppContext();

  const [activeTab, setActiveTab] = useState('Generated Invoices');
  const [selectedMonth, setSelectedMonth] = useState(getPreviousMonth);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceSummary | null>(null);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [generatePrefill, setGeneratePrefill] = useState<{
    buyerWalletVkey: string;
    month: string;
    forceRegenerate?: boolean;
  }>({ buyerWalletVkey: '', month: '' });
  const [expandedWallets, setExpandedWallets] = useState<Set<string>>(new Set());

  const {
    invoices,
    isLoading: isLoadingInvoices,
    hasMore: hasMoreInvoices,
    loadMore: loadMoreInvoices,
    isFetchingNextPage: isFetchingNextInvoices,
    refetch: refetchInvoices,
  } = useInvoices(selectedMonth);

  const {
    payments: uninvoicedPayments,
    isLoading: isLoadingUninvoiced,
    hasMore: hasMoreUninvoiced,
    loadMore: loadMoreUninvoiced,
    isFetchingNextPage: isFetchingNextUninvoiced,
    refetch: refetchUninvoiced,
  } = useUninvoicedPayments(selectedMonth);

  const tabs = useMemo(
    () => [
      { name: 'Generated Invoices', count: null },
      { name: 'Missing Invoices', count: uninvoicedPayments.length || null },
    ],
    [uninvoicedPayments.length],
  );

  const filteredInvoices = useMemo(() => {
    if (!searchQuery) return invoices;
    const query = searchQuery.toLowerCase();
    return invoices.filter(
      (inv) =>
        inv.invoiceId.toLowerCase().includes(query) ||
        inv.sellerName?.toLowerCase().includes(query) ||
        inv.sellerCompanyName?.toLowerCase().includes(query) ||
        inv.buyerName?.toLowerCase().includes(query) ||
        inv.buyerCompanyName?.toLowerCase().includes(query),
    );
  }, [invoices, searchQuery]);

  const walletGroups = useMemo(() => {
    const groups = groupBySellerBuyer(uninvoicedPayments);
    if (!searchQuery) return groups;
    const query = searchQuery.toLowerCase();
    return groups.filter(
      (g) =>
        g.buyerWalletVkey.toLowerCase().includes(query) ||
        g.sellerWalletVkey.toLowerCase().includes(query),
    );
  }, [uninvoicedPayments, searchQuery]);

  const toggleWallet = useCallback((vkey: string) => {
    setExpandedWallets((prev) => {
      const next = new Set(prev);
      if (next.has(vkey)) {
        next.delete(vkey);
      } else {
        next.add(vkey);
      }
      return next;
    });
  }, []);

  const handleRefresh = useCallback(() => {
    refetchInvoices();
    refetchUninvoiced();
  }, [refetchInvoices, refetchUninvoiced]);

  const handleGenerateSuccess = useCallback(() => {
    refetchInvoices();
    refetchUninvoiced();
  }, [refetchInvoices, refetchUninvoiced]);

  const handleRegenerate = useCallback((invoice: InvoiceSummary) => {
    if (!invoice.buyerWalletVkey) return;
    const month = `${invoice.invoiceYear}-${String(invoice.invoiceMonth).padStart(2, '0')}`;
    setGeneratePrefill({
      buyerWalletVkey: invoice.buyerWalletVkey,
      month,
      forceRegenerate: true,
    });
    setSelectedInvoice(null);
    setShowGenerateDialog(true);
  }, []);

  const openGenerateFromGroup = useCallback(
    (group: WalletGroup) => {
      setGeneratePrefill({ buyerWalletVkey: group.buyerWalletVkey, month: selectedMonth });
      setShowGenerateDialog(true);
    },
    [selectedMonth],
  );

  const isCurrentMonth = useMemo(() => {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return selectedMonth === current;
  }, [selectedMonth]);

  const isLoading = activeTab === 'Generated Invoices' ? isLoadingInvoices : isLoadingUninvoiced;

  return (
    <MainLayout>
      <Head>
        <title>Invoices | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
              <p className="text-sm text-muted-foreground">
                View and generate monthly invoices for buyer wallets.
              </p>
            </div>
            <RefreshButton onRefresh={handleRefresh} isRefreshing={isLoading} />
          </div>

          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-4 py-3 text-sm">
            <span className="font-medium text-yellow-600 dark:text-yellow-400">Beta</span>
            <span className="text-muted-foreground">
              {' '}
              — This invoice feature is in beta. Generated invoices should be reviewed manually or
              verified with a tax advisor before use. Use at your own discretion.
            </span>
          </div>

          <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

          {/* Controls */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <MonthPicker value={selectedMonth} onChange={setSelectedMonth} />
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={
                  activeTab === 'Generated Invoices'
                    ? 'Search by ID, seller, buyer...'
                    : 'Search by wallet vkey...'
                }
                className="max-w-xs"
              />
            </div>
          </div>

          {/* Tab 1: Generated Invoices */}
          {activeTab === 'Generated Invoices' && (
            <>
              <div className="border rounded-lg overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/30 dark:bg-muted/15">
                    <tr className="border-b">
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground pl-6">
                        Invoice ID
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Seller
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Buyer
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Date
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Currency
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Items
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Net
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        VAT
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Gross
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                        Status
                      </th>
                      <th className="p-4 text-left text-sm font-medium text-muted-foreground pr-8">
                        Revisions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingInvoices && invoices.length === 0 ? (
                      <InvoiceTableSkeleton rows={5} />
                    ) : filteredInvoices.length === 0 ? (
                      <tr>
                        <td colSpan={11}>
                          <EmptyState
                            icon="inbox"
                            title="No invoices found"
                            description="Invoices will appear here once generated."
                          />
                        </td>
                      </tr>
                    ) : (
                      filteredInvoices.map((invoice, index) => (
                        <tr
                          key={invoice.id}
                          className={cn(
                            'border-b last:border-b-0 animate-fade-in opacity-0 transition-[background-color,opacity] duration-150',
                            'cursor-pointer hover:bg-muted/50',
                          )}
                          style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                          onClick={() => setSelectedInvoice(invoice)}
                        >
                          <td className="p-4 pl-6">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm">{invoice.invoiceId}</span>
                              <CopyButton value={invoice.invoiceId} />
                            </div>
                          </td>
                          <td className="p-4 text-sm">
                            {invoice.sellerCompanyName || invoice.sellerName || '—'}
                          </td>
                          <td className="p-4 text-sm">
                            {invoice.buyerCompanyName || invoice.buyerName || '—'}
                          </td>
                          <td className="p-4 text-sm">
                            {new Date(invoice.invoiceDate).toLocaleDateString()}
                          </td>
                          <td className="p-4 text-sm uppercase">{invoice.currencyShortId}</td>
                          <td className="p-4 text-sm">{invoice.itemCount}</td>
                          <td className="p-4 text-sm">{invoice.netTotal}</td>
                          <td className="p-4 text-sm">{invoice.vatTotal}</td>
                          <td className="p-4 text-sm font-medium">{invoice.grossTotal}</td>
                          <td className="p-4">
                            {invoice.isCancelled ? (
                              <Badge variant="destructive">Cancelled</Badge>
                            ) : (
                              <Badge variant="success">Active</Badge>
                            )}
                          </td>
                          <td className="p-4 pr-8 text-sm text-muted-foreground">
                            {invoice.revisionCount}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-4 items-center">
                {!isLoadingInvoices && (
                  <Pagination
                    hasMore={hasMoreInvoices}
                    isLoading={isFetchingNextInvoices}
                    onLoadMore={loadMoreInvoices}
                  />
                )}
              </div>
            </>
          )}

          {/* Tab 2: Missing Invoices */}
          {activeTab === 'Missing Invoices' && (
            <>
              <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-muted-foreground">
                Only finalized payments are shown (Withdrawn, Result Submitted past unlock time, or
                Disputed Withdrawn with seller funds). Payments that are still locked, pending
                refund, or in dispute are excluded.
              </div>

              <div className="border rounded-lg overflow-hidden">
                {isLoadingUninvoiced && uninvoicedPayments.length === 0 ? (
                  <div className="p-8 flex justify-center">
                    <Spinner size={20} addContainer />
                  </div>
                ) : walletGroups.length === 0 ? (
                  <EmptyState
                    icon="inbox"
                    title="No uninvoiced payments"
                    description="All billable payments for this month have invoices."
                  />
                ) : (
                  <div className="divide-y">
                    {walletGroups.map((group) => {
                      const groupKey = `${group.sellerWalletVkey}::${group.buyerWalletVkey}`;
                      const isExpanded = expandedWallets.has(groupKey);
                      return (
                        <div key={groupKey}>
                          {/* Wallet group header */}
                          <div
                            className="flex items-center gap-3 p-4 hover:bg-muted/50 cursor-pointer transition-colors"
                            onClick={() => toggleWallet(groupKey)}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="mb-1">
                                <span className="text-xs text-muted-foreground">Seller</span>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-sm">
                                    {shortenAddress(group.sellerWalletVkey, 8)}
                                  </span>
                                  <CopyButton value={group.sellerWalletVkey} />
                                </div>
                                {group.sellerWalletAddress && (
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-xs text-muted-foreground font-mono">
                                      {shortenAddress(group.sellerWalletAddress, 8)}
                                    </span>
                                    <CopyButton value={group.sellerWalletAddress} />
                                  </div>
                                )}
                              </div>
                              <div>
                                <span className="text-xs text-muted-foreground">Buyer</span>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-sm">
                                    {shortenAddress(group.buyerWalletVkey, 8)}
                                  </span>
                                  <CopyButton value={group.buyerWalletVkey} />
                                </div>
                                {group.buyerWalletAddress && (
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-xs text-muted-foreground font-mono">
                                      {shortenAddress(group.buyerWalletAddress, 8)}
                                    </span>
                                    <CopyButton value={group.buyerWalletAddress} />
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-4 shrink-0">
                              <div className="text-sm text-muted-foreground">
                                {group.payments.length} payment
                                {group.payments.length !== 1 ? 's' : ''}
                              </div>
                              <div className="text-sm">
                                {Object.entries(group.totalFunds).map(([unit, amount]) => (
                                  <div key={unit}>
                                    {formatPrice(amount.toString())} {formatFundUnit(unit, network)}
                                  </div>
                                ))}
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isCurrentMonth}
                                title={
                                  isCurrentMonth
                                    ? 'Cannot generate invoices for the current month'
                                    : undefined
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openGenerateFromGroup(group);
                                }}
                              >
                                Generate Invoice
                              </Button>
                            </div>
                          </div>

                          {/* Expanded payment rows */}
                          {isExpanded && (
                            <div className="bg-muted/20 border-t">
                              <table className="w-full">
                                <thead>
                                  <tr className="border-b">
                                    <th className="p-3 pl-12 text-left text-xs font-medium text-muted-foreground">
                                      Payment ID
                                    </th>
                                    <th className="p-3 text-left text-xs font-medium text-muted-foreground">
                                      Status
                                    </th>
                                    <th className="p-3 text-left text-xs font-medium text-muted-foreground">
                                      Finalized
                                    </th>
                                    <th className="p-3 text-left text-xs font-medium text-muted-foreground">
                                      Requested Funds
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {group.payments.map((payment) => (
                                    <tr key={payment.id} className="border-b last:border-b-0">
                                      <td className="p-3 pl-12">
                                        <div className="flex items-center gap-2">
                                          <span className="font-mono text-xs">
                                            {shortenAddress(payment.id, 6)}
                                          </span>
                                          <CopyButton value={payment.id} />
                                        </div>
                                      </td>
                                      <td className="p-3">
                                        <span
                                          className={cn(
                                            'text-xs',
                                            getStatusColor(payment.onChainState),
                                          )}
                                        >
                                          {formatStatus(payment.onChainState)}
                                        </span>
                                      </td>
                                      <td className="p-3 text-xs text-muted-foreground">
                                        {new Date(payment.finalizedAt).toLocaleString()}
                                      </td>
                                      <td className="p-3 text-xs">
                                        {payment.RequestedFunds.map((fund, i) => (
                                          <div key={i}>
                                            {formatPrice(fund.amount)}{' '}
                                            {formatFundUnit(fund.unit, network)}
                                          </div>
                                        ))}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-4 items-center">
                {!isLoadingUninvoiced && (
                  <Pagination
                    hasMore={hasMoreUninvoiced}
                    isLoading={isFetchingNextUninvoiced}
                    onLoadMore={loadMoreUninvoiced}
                  />
                )}
              </div>
            </>
          )}
        </div>

        <InvoiceDetailsDialog
          selectedInvoice={selectedInvoice}
          onClose={() => setSelectedInvoice(null)}
          onRegenerate={handleRegenerate}
        />

        <GenerateInvoiceDialog
          open={showGenerateDialog}
          onClose={() => setShowGenerateDialog(false)}
          onSuccess={handleGenerateSuccess}
          prefillBuyerWalletVkey={generatePrefill.buyerWalletVkey}
          prefillMonth={generatePrefill.month}
          prefillForceRegenerate={generatePrefill.forceRegenerate}
          formatMonth={formatMonthLabel}
        />
      </AnimatedPage>
    </MainLayout>
  );
}
