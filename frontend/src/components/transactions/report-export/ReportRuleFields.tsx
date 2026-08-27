import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InfoHint } from '@/components/ui/info-hint';
import {
  REPORT_DATE_BASIS_HINTS,
  REPORT_DATE_BASIS_LABELS,
  REPORT_REVENUE_MODE_HINTS,
  REPORT_REVENUE_MODE_LABELS,
} from '@/lib/transaction-report/report-labels';
import type { ReportDateBasis, ReportRevenueMode } from '../download-details.helpers';
import type { useDownloadDetailsModel } from '../useDownloadDetailsModel';

type ReportModel = ReturnType<typeof useDownloadDetailsModel>;

/**
 * The two rules that decide which period a payment lands in and how much of it
 * counts. They change every figure in the file, so both carry their own
 * explanation instead of an accounting term on its own.
 */
export function ReportRuleFields({ model }: Readonly<{ model: ReportModel }>) {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="report-date-basis">Count a payment by</Label>
          <InfoHint label="date rule">
            <p>Decides which day a request belongs to, and so which period it falls in.</p>
            <p>
              Take a job requested on 28 March, funded on 30 March, and unlocked on 2 April. It
              lands in March under the request and funding rules, and in April under the revenue
              rule.
            </p>
            <p>The revenue rule follows the rule you pick below it.</p>
          </InfoHint>
        </div>
        <Select
          value={model.form.dateBasis}
          onValueChange={(value) => model.updateForm({ dateBasis: value as ReportDateBasis })}
        >
          <SelectTrigger id="report-date-basis">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(REPORT_DATE_BASIS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {REPORT_DATE_BASIS_HINTS[model.form.dateBasis]}
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="report-revenue-mode">Count revenue when it is</Label>
          <InfoHint label="revenue rule">
            <p>Decides how much of a request counts, and in which period it lands.</p>
            <p>
              <span className="font-medium text-foreground">Earned.</span> A request counts once the
              escrow unlocks, even while the payout still sits in the contract. This is accrual
              accounting. A job unlocked on 30 June counts in June, though you withdraw in July.
            </p>
            <p>
              <span className="font-medium text-foreground">Paid out.</span> A request counts only
              after the funds leave the escrow for your wallet. This is cash accounting. The same
              job counts in July.
            </p>
            <p>
              <span className="font-medium text-foreground">Requested.</span> Every request counts
              at the amount that was asked for, settled or not. It shows the pipeline, and it
              overstates income for the books.
            </p>
          </InfoHint>
        </div>
        <Select
          value={model.form.revenueMode}
          onValueChange={(value) => model.updateForm({ revenueMode: value as ReportRevenueMode })}
        >
          <SelectTrigger id="report-revenue-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(REPORT_REVENUE_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {REPORT_REVENUE_MODE_HINTS[model.form.revenueMode]}
        </p>
      </div>
    </div>
  );
}
