import type { ReactNode } from 'react';
import { Download, FileArchive, FileSpreadsheet, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InfoHint } from '@/components/ui/info-hint';
import { getReportTransactionCountDisplay } from '@/lib/transaction-report/dashboard-metrics';
import type {
  TransactionReportFormState,
  TransactionReportViewDefaults,
} from './download-details.helpers';
import { ExportAssetNote } from './report-export/ExportAssetNote';
import { ExportKindPicker } from './report-export/ExportKindPicker';
import { FiatSettingsField } from './report-export/FiatSettingsField';
import { isEveryReportCsvKind } from './report-export/export-kinds';
import { PurposePicker } from './report-export/PurposePicker';
import { REPORT_PURPOSES, reportPurposeShows } from './report-export/report-purposes';
import { ReportRuleFields } from './report-export/ReportRuleFields';
import { ReportScopeFields } from './report-export/ReportScopeFields';
import { SelectionSummary } from './report-export/SelectionSummary';
import { useDownloadDetailsModel } from './useDownloadDetailsModel';

type DownloadDetailsDialogProps = Readonly<{
  open: boolean;
  onClose: () => void;
  viewDefaults: TransactionReportViewDefaults;
  /** Opens the dialog on the caller's current filters instead of the defaults. */
  initialForm?: TransactionReportFormState;
}>;

function DialogSection({
  step,
  title,
  description,
  children,
}: Readonly<{ step: number; title: string; description: string; children: ReactNode }>) {
  return (
    <section className="space-y-3 border-t px-6 py-5">
      <div>
        <h3 className="text-sm font-semibold">
          <span className="mr-2 text-muted-foreground">{step}</span>
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function DownloadDetailsDialog({
  open,
  onClose,
  viewDefaults,
  initialForm,
}: DownloadDetailsDialogProps) {
  const model = useDownloadDetailsModel({ open, onClose, viewDefaults, initialForm });
  const previewCountDisplay = model.preview
    ? getReportTransactionCountDisplay(
        model.preview.totals.transactionCount,
        model.preview.totals.transactionCountCompleteness,
        'matching request',
      )
    : null;
  const fileCount = model.exportKinds.length;
  const wantsZip = isEveryReportCsvKind(model.exportKinds);
  const downloadLabel = wantsZip
    ? 'Download ZIP'
    : fileCount === 1
      ? 'Download file'
      : `Download ${fileCount} files`;
  const isCustom = model.purpose === 'custom';
  const showRules = reportPurposeShows(model.purpose, 'rules');
  const selectedSource = model.paymentSources.find(
    (source) => source.id === model.form.paymentSourceId,
  );

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent size="lg" className="gap-0 p-0">
        <div className="border-b bg-muted/20 px-6 pb-5 pt-9">
          <DialogHeader>
            <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Financial reporting
            </div>
            <DialogTitle className="text-xl">Export transaction report</DialogTitle>
            <DialogDescription className="flex items-start gap-1">
              <span>
                Revenue, spend, refunds, protocol fees, and Cardano fees for the payment source you
                are working in.
              </span>
              {selectedSource && (
                <InfoHint label="payment source">
                  <p>
                    {selectedSource.paymentSourceType === 'Web3CardanoV2'
                      ? 'Cardano V2'
                      : 'Cardano V1'}{' '}
                    on {selectedSource.network}.
                  </p>
                  <p className="font-mono text-xs break-all">
                    {selectedSource.smartContractAddress}
                  </p>
                  <p>
                    The protocol fee rate is {selectedSource.feeRatePermille / 10}% of gross
                    revenue.
                  </p>
                </InfoHint>
              )}
            </DialogDescription>
          </DialogHeader>
        </div>

        {viewDefaults.hasUnmappedFilters && (
          <p className="border-b bg-muted/10 px-6 py-3 text-xs text-muted-foreground">
            Source, side, and state filters carry over from the list you came from. Search, error
            type, and manual-action filters do not apply to financial reports.
          </p>
        )}

        <section className="space-y-3 px-6 py-5">
          <div>
            <h3 className="text-sm font-semibold">
              <span className="mr-2 text-muted-foreground">1</span>
              What do you need?
            </h3>
            <p className="text-xs text-muted-foreground">
              This picks the files and shows only the filters that job uses.
            </p>
          </div>
          <PurposePicker value={model.purpose} onChange={model.setPurpose} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {isCustom
                ? 'Custom: every filter and rule is shown.'
                : 'Filters this job does not use are cleared, so a file never carries a filter you cannot see.'}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => model.setPurpose(isCustom ? 'accounting' : 'custom')}
            >
              {isCustom ? 'Back to guided export' : 'Show all filters'}
            </Button>
          </div>
        </section>

        <DialogSection
          step={2}
          title="Which requests"
          description={REPORT_PURPOSES[model.purpose].detail}
        >
          <ReportScopeFields model={model} />
        </DialogSection>

        {showRules && (
          <DialogSection
            step={3}
            title="Accounting rules"
            description="These two rules change every figure in the file."
          >
            <ReportRuleFields model={model} />
          </DialogSection>
        )}

        <DialogSection
          step={showRules ? 4 : 3}
          title="Currency"
          description="Keep the crypto amounts as they are, or add a converted column beside them."
        >
          <FiatSettingsField
            currency={model.form.fiatCurrency}
            mode={model.form.fiatMode}
            capability={model.fiatCapability}
            issue={model.fiatIssue}
            onChange={model.updateForm}
            idPrefix="export"
          />
        </DialogSection>

        <DialogSection
          step={showRules ? 5 : 4}
          title="Files"
          description="Pick how far the numbers are already added up."
        >
          <ExportKindPicker
            selected={model.exportKinds}
            onToggle={model.toggleExportKind}
            onToggleAll={model.setAllExportKinds}
          />
          <ExportAssetNote model={model} />
        </DialogSection>

        <div className="sticky bottom-0 space-y-3 border-t bg-background/95 px-6 py-4 backdrop-blur">
          <SelectionSummary model={model} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-h-10 min-w-0" aria-live="polite">
              {model.facetsError ? (
                <p className="text-sm text-destructive">{model.facetsError}</p>
              ) : model.isLoadingFacets ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading report filters…
                </p>
              ) : model.bodyError ? (
                <p className="text-sm text-destructive">{model.bodyError}</p>
              ) : model.fiatIssue ? (
                <p className="text-sm text-destructive">{model.fiatIssue.message}</p>
              ) : model.previewError ? (
                <p className="text-sm text-destructive">{model.previewError}</p>
              ) : model.isPreviewLoading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Counting matching requests…
                </p>
              ) : model.preview ? (
                <div>
                  <p className="text-sm font-medium">{previewCountDisplay?.text}</p>
                  <p className="text-xs text-muted-foreground">
                    {fileCount === 0
                      ? 'Pick at least one file above.'
                      : fileCount === 2
                        ? 'Two files, downloaded one after the other.'
                        : model.preview.metadata.warnings.length > 0
                          ? 'Some figures are estimates. The file says which ones.'
                          : 'One server snapshot drives every exported value.'}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Counting matching requests…</p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={model.reset}
                disabled={model.isDownloading}
              >
                <RotateCcw className="h-4 w-4" /> Reset
              </Button>
              <Button
                onClick={() => model.download()}
                disabled={
                  model.isDownloading ||
                  fileCount === 0 ||
                  model.bodyError != null ||
                  model.fiatIssue != null ||
                  model.facetsError != null ||
                  model.paymentSources.length === 0
                }
              >
                {model.isDownloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : wantsZip ? (
                  <FileArchive className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {model.isDownloading ? 'Preparing…' : downloadLabel}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
