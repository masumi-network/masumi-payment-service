import type { ReactNode } from 'react';
import { getAgentTypeLabel } from '@/lib/agent-type';
import type { MasumiOptionDraft, PaymentOptionRow } from '@/lib/agent-registration';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { formatFundUnit } from '@/lib/utils';
import { formatPaymentOptionReviewLine } from '@/lib/register-agent-review';
import type { X402OptionDraft } from '@/lib/x402-registration';
import type { VerificationDraft } from './VerificationsSection';
import type { AgentFormValues } from './register-agent-schema';

function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b bg-muted/20 px-4 py-3">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="divide-y px-4">{children}</div>
    </section>
  );
}

function SummaryRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="py-3 first:pt-3 last:pb-3">
      <div className="flex items-start justify-between gap-4">
        <span className="text-sm text-muted-foreground shrink-0">{label}</span>
        <span className="text-sm text-right break-words min-w-0">{value}</span>
      </div>
      {detail ? (
        <p className="mt-1 text-xs text-muted-foreground text-right break-all">{detail}</p>
      ) : null}
    </div>
  );
}

function hasAdditionalDetails(values: AgentFormValues): boolean {
  const exampleOutputs = values.exampleOutputs ?? [];
  return Boolean(
    values.authorName?.trim() ||
    values.authorEmail?.trim() ||
    values.organization?.trim() ||
    values.contactOther?.trim() ||
    values.termsOfUseUrl?.trim() ||
    values.privacyPolicyUrl?.trim() ||
    values.otherUrl?.trim() ||
    values.capabilityName?.trim() ||
    values.capabilityVersion?.trim() ||
    exampleOutputs.some(
      (example) => example.name.trim() || example.url.trim() || example.mimeType.trim(),
    ),
  );
}

export function RegisterAgentReviewSection({
  values,
  mintingWalletLabel,
  holdingWalletLabel,
  paymentOptionRows,
  masumiOptions,
  x402Options,
  verifications,
  isV2Target,
  network,
  pricingSummary,
}: {
  values: AgentFormValues;
  mintingWalletLabel: string;
  holdingWalletLabel: string;
  paymentOptionRows: PaymentOptionRow[];
  masumiOptions: MasumiOptionDraft[];
  x402Options: X402OptionDraft[];
  verifications: VerificationDraft[];
  isV2Target: boolean;
  network: NetworkType;
  pricingSummary: string;
}) {
  const legacyPriceSummary =
    !isV2Target && values.pricingType === 'Fixed'
      ? values.prices
          .filter((price) => price.amount.trim())
          .map((price) => `${price.amount} ${formatFundUnit(price.unit, network)}`)
          .join(', ') || 'Fixed pricing (no amount set)'
      : null;

  return (
    <div className="space-y-3">
      <ReviewSection title="Agent details">
        <SummaryRow label="Name" value={values.name} />
        <SummaryRow label="Type" value={getAgentTypeLabel(values.agentType)} />
        <SummaryRow label="Description" value={values.description || '—'} />
        {values.agentType === 'Standard' && values.apiUrl ? (
          <SummaryRow label="API URL" value={values.apiUrl} />
        ) : null}
        {values.agentType === 'OpenApi' && values.openApiSpecUrl ? (
          <SummaryRow label="OpenAPI spec" value={values.openApiSpecUrl} />
        ) : null}
        {values.agentType === 'X402' && values.x402ResourcesUrl ? (
          <SummaryRow label="x402 resources" value={values.x402ResourcesUrl} />
        ) : null}
        <SummaryRow label="Tags" value={values.tags.length ? values.tags.join(', ') : '—'} />
      </ReviewSection>

      <ReviewSection title="Wallets & pricing">
        <SummaryRow label="Minting wallet" value={mintingWalletLabel} />
        <SummaryRow label="Holding wallet" value={holdingWalletLabel} />
        {values.sendFundingAda ? (
          <SummaryRow label="Holding wallet funding" value={`${values.sendFundingAda} ADA`} />
        ) : null}
        <SummaryRow label="Pricing" value={legacyPriceSummary ?? pricingSummary} />
      </ReviewSection>

      {paymentOptionRows.length > 0 ? (
        <ReviewSection title="Payment options">
          {paymentOptionRows.map((optionRow, optionIndex) => {
            const masumiOption =
              optionRow.type === 'Masumi'
                ? masumiOptions.find((option) => option.id === optionRow.id)
                : undefined;
            const x402Option =
              optionRow.type === 'x402'
                ? x402Options.find((option) => option.id === optionRow.id)
                : undefined;
            const line = formatPaymentOptionReviewLine({
              optionRow,
              optionIndex,
              masumiOption,
              x402Option,
              network,
            });
            return (
              <SummaryRow
                key={optionRow.id}
                label={line.title}
                value={line.summary}
                detail={line.detail}
              />
            );
          })}
        </ReviewSection>
      ) : null}

      {verifications.length > 0 ? (
        <ReviewSection title="Verifications">
          {verifications.map((verification, index) => (
            <SummaryRow
              key={verification.id}
              label={`Verification ${index + 1}`}
              value={verification.method}
              detail={verification.issuerAid ? `Issuer ${verification.issuerAid}` : undefined}
            />
          ))}
        </ReviewSection>
      ) : null}

      {hasAdditionalDetails(values) ? (
        <ReviewSection title="Additional details">
          {values.authorName?.trim() ? (
            <SummaryRow label="Author" value={values.authorName} />
          ) : null}
          {values.authorEmail?.trim() ? (
            <SummaryRow label="Author email" value={values.authorEmail} />
          ) : null}
          {values.organization?.trim() ? (
            <SummaryRow label="Organization" value={values.organization} />
          ) : null}
          {values.contactOther?.trim() ? (
            <SummaryRow label="Contact" value={values.contactOther} />
          ) : null}
          {values.termsOfUseUrl?.trim() ? (
            <SummaryRow label="Terms of use" value={values.termsOfUseUrl} />
          ) : null}
          {values.privacyPolicyUrl?.trim() ? (
            <SummaryRow label="Privacy policy" value={values.privacyPolicyUrl} />
          ) : null}
          {values.otherUrl?.trim() ? (
            <SummaryRow label="Other URL" value={values.otherUrl} />
          ) : null}
          {values.capabilityName?.trim() || values.capabilityVersion?.trim() ? (
            <SummaryRow
              label="Capability"
              value={[values.capabilityName, values.capabilityVersion].filter(Boolean).join(' · ')}
            />
          ) : null}
          {(values.exampleOutputs ?? []).some(
            (example) => example.name.trim() || example.url.trim(),
          ) ? (
            <SummaryRow
              label="Example outputs"
              value={`${(values.exampleOutputs ?? []).filter((example) => example.name.trim() || example.url.trim()).length} configured`}
            />
          ) : null}
        </ReviewSection>
      ) : null}
    </div>
  );
}
