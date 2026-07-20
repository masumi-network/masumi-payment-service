import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { X, AlertTriangle, Zap } from 'lucide-react';
import { formatDateTime } from '@/lib/format-date';
import { shortenAddress } from '@/lib/utils';
import {
  formatRuleAmount,
  getAssetUnitBreakdown,
  getRuleAssetLabel,
  getRuleAssetMeta,
  getThresholdInputFromRaw,
  parseThresholdInputToRaw,
  validateRuleTopupInput,
  type LowBalanceRule,
  type LowBalanceSummary,
  type RuleAssetMeta,
  type RuleAssetPreset,
  type RuleDraft,
} from '@/components/wallets/wallet-details-utils';

function AutoTopupControl({
  checked,
  onCheckedChange,
  amountInput,
  onAmountInputChange,
  assetLabel,
  placeholder,
  error,
  rawAmount,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  amountInput: string;
  onAmountInputChange: (value: string) => void;
  assetLabel: string;
  placeholder: string;
  error: string | null;
  rawAmount: string | null;
  ariaLabel: string;
}) {
  return (
    <div className="border-t pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
            <Zap className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm font-medium">Auto top-up</div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              When this rule enters Low, a funding wallet on the same source sends a fixed amount.
            </div>
          </div>
        </div>
        <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={ariaLabel} />
      </div>

      {checked && (
        <div className="mt-3 space-y-1.5 sm:ml-11 sm:max-w-sm">
          <div className="text-xs font-medium">Top-up amount ({assetLabel})</div>
          <Input
            value={amountInput}
            inputMode="decimal"
            onChange={(event) => onAmountInputChange(event.target.value)}
            placeholder={placeholder}
            aria-invalid={error != null}
          />
          {error ? (
            <div className="text-[11px] text-destructive">{error}</div>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              Amount sent per transition. Stored raw:{' '}
              <span className="font-mono text-foreground">{rawAmount}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LowBalanceRulesSection({
  monitoringSummary,
  configuredRules,
  lowRules,
  enabledRuleCount,
  network,
  supportsAutoTopup,
  isWalletDetailsLoading,
  ruleDrafts,
  mutatingRuleIds,
  updateRuleDraft,
  onSaveRule,
  onDeleteRule,
  newRuleAssetPreset,
  setNewRuleAssetPreset,
  newRuleThresholdInput,
  setNewRuleThresholdInput,
  newRuleCustomAssetUnit,
  setNewRuleCustomAssetUnit,
  newRuleEnabled,
  setNewRuleEnabled,
  newRuleTopupEnabled,
  setNewRuleTopupEnabled,
  newRuleTopupAmountInput,
  setNewRuleTopupAmountInput,
  addRuleAssetMeta,
  newRuleAssetBreakdown,
  newRuleRawThreshold,
  newRuleRawTopup,
  newRuleTopupError,
  canCreateNewRule,
  onCreateRule,
  isCreatingRule,
}: {
  monitoringSummary: LowBalanceSummary;
  configuredRules: LowBalanceRule[];
  lowRules: LowBalanceRule[];
  enabledRuleCount: number;
  network: 'Preprod' | 'Mainnet';
  supportsAutoTopup: boolean;
  isWalletDetailsLoading: boolean;
  ruleDrafts: Record<string, RuleDraft>;
  mutatingRuleIds: Set<string>;
  updateRuleDraft: (ruleId: string, updates: Partial<RuleDraft>) => void;
  onSaveRule: (rule: LowBalanceRule) => void;
  onDeleteRule: (rule: LowBalanceRule) => void;
  newRuleAssetPreset: RuleAssetPreset;
  setNewRuleAssetPreset: (preset: RuleAssetPreset) => void;
  newRuleThresholdInput: string;
  setNewRuleThresholdInput: (value: string) => void;
  newRuleCustomAssetUnit: string;
  setNewRuleCustomAssetUnit: (value: string) => void;
  newRuleEnabled: boolean;
  setNewRuleEnabled: (value: boolean) => void;
  newRuleTopupEnabled: boolean;
  setNewRuleTopupEnabled: (value: boolean) => void;
  newRuleTopupAmountInput: string;
  setNewRuleTopupAmountInput: (value: string) => void;
  addRuleAssetMeta: RuleAssetMeta;
  newRuleAssetBreakdown: ReturnType<typeof getAssetUnitBreakdown>;
  newRuleRawThreshold: string | null;
  newRuleRawTopup: string | null;
  newRuleTopupError: string | null;
  canCreateNewRule: boolean;
  onCreateRule: () => void;
  isCreatingRule: boolean;
}) {
  return (
    <section
      className={`space-y-4 rounded-xl border p-4 ${
        monitoringSummary.isLow
          ? 'border-amber-500/40 bg-amber-500/10'
          : 'border-border bg-muted/40'
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Low Balance Monitoring</h3>
            <Badge variant={monitoringSummary.isLow ? 'destructive' : 'secondary'}>
              {monitoringSummary.isLow
                ? `${monitoringSummary.lowRuleCount} warning${monitoringSummary.lowRuleCount === 1 ? '' : 's'}`
                : enabledRuleCount > 0
                  ? `${enabledRuleCount} active`
                  : 'Not configured'}
            </Badge>
          </div>
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            New wallets inherit default monitoring rules automatically. Supported assets are edited
            in human units here and converted to on-chain quantities when saved. Custom assets show
            the underlying policy ID and asset-name hex parts.
          </p>
        </div>
        <div className="grid min-w-0 grid-cols-3 gap-2 sm:min-w-[260px]">
          <div className="rounded-lg border bg-background/70 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Rules</div>
            <div className="mt-1 text-lg font-semibold">{configuredRules.length}</div>
          </div>
          <div className="rounded-lg border bg-background/70 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Low</div>
            <div className="mt-1 text-lg font-semibold">{lowRules.length}</div>
          </div>
          <div className="rounded-lg border bg-background/70 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Checked</div>
            <div className="mt-1 text-xs font-medium text-foreground">
              {monitoringSummary.lastCheckedAt
                ? monitoringSummary.lastCheckedAt.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'Never'}
            </div>
          </div>
        </div>
      </div>

      {monitoringSummary.lastCheckedAt && (
        <div className="text-xs text-muted-foreground">
          Last full check {formatDateTime(monitoringSummary.lastCheckedAt)}
        </div>
      )}

      {isWalletDetailsLoading ? (
        <div className="flex justify-center py-6">
          <Spinner size={18} />
        </div>
      ) : (
        <>
          {lowRules.length > 0 && (
            <div className="space-y-2">
              {lowRules.map((rule) => (
                <div
                  key={`low-warning-${rule.id}`}
                  className="rounded-lg border border-amber-500/40 bg-background/80 px-4 py-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>
                        {getRuleAssetLabel(rule.assetUnit, network)} dropped below threshold
                      </span>
                    </div>
                    <Badge variant="destructive" className="w-fit">
                      {formatRuleAmount(rule.lastKnownAmount, rule.assetUnit, network)}
                    </Badge>
                  </div>
                  <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <div>
                      Threshold:{' '}
                      <span className="text-foreground">
                        {formatRuleAmount(rule.thresholdAmount, rule.assetUnit, network)}
                      </span>
                    </div>
                    <div>
                      Asset unit:{' '}
                      <span className="font-mono text-foreground">
                        {shortenAddress(rule.assetUnit, 8)}
                      </span>
                    </div>
                    <div>
                      Last warning:{' '}
                      <span className="text-foreground">
                        {rule.lastAlertedAt ? formatDateTime(rule.lastAlertedAt) : 'Not sent'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {configuredRules.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-background/70 p-4 text-sm text-muted-foreground">
                No low-balance rules configured for this wallet yet.
              </div>
            ) : (
              configuredRules.map((rule) => {
                const assetMeta = getRuleAssetMeta(rule.assetUnit, network);
                const assetBreakdown = getAssetUnitBreakdown(rule.assetUnit);
                const draft = ruleDrafts[rule.id] ?? {
                  thresholdInput: getThresholdInputFromRaw(
                    rule.thresholdAmount,
                    rule.assetUnit,
                    network,
                  ),
                  enabled: rule.enabled,
                  topupEnabled: rule.topupEnabled,
                  topupAmountInput:
                    rule.topupAmount != null
                      ? getThresholdInputFromRaw(rule.topupAmount, rule.assetUnit, network)
                      : '',
                };
                const draftRawThreshold = parseThresholdInputToRaw(
                  draft.thresholdInput,
                  rule.assetUnit,
                  network,
                );
                const effectiveTopupEnabled = supportsAutoTopup && draft.topupEnabled;
                const draftTopupValidation = validateRuleTopupInput({
                  enabled: effectiveTopupEnabled,
                  topupAmountInput: draft.topupAmountInput,
                  assetUnit: rule.assetUnit,
                  network,
                });
                const draftRawTopup = draftTopupValidation.rawTopupAmount;
                const hasChanges =
                  draftRawThreshold !== rule.thresholdAmount ||
                  draft.enabled !== rule.enabled ||
                  effectiveTopupEnabled !== rule.topupEnabled ||
                  (effectiveTopupEnabled && draftRawTopup !== rule.topupAmount);
                const topupInvalid = draftTopupValidation.error != null;
                const isMutating = mutatingRuleIds.has(rule.id);

                return (
                  <div
                    key={rule.id}
                    className={`rounded-xl border bg-background/75 p-4 ${
                      rule.enabled && rule.status === 'Low'
                        ? 'border-amber-500/40'
                        : 'border-border'
                    }`}
                  >
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold">{assetMeta.label}</span>
                            <Badge
                              variant={
                                !rule.enabled
                                  ? 'outline'
                                  : rule.status === 'Low'
                                    ? 'destructive'
                                    : 'secondary'
                              }
                            >
                              {!rule.enabled ? 'Disabled' : rule.status}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {assetMeta.helperText}
                          </div>
                          <div className="font-mono text-[11px] leading-relaxed text-muted-foreground break-all">
                            {rule.assetUnit}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete low-balance alert"
                          className="h-8 w-8 shrink-0"
                          onClick={() => onDeleteRule(rule)}
                          disabled={isMutating}
                        >
                          {isMutating ? <Spinner size={12} /> : <X className="h-3.5 w-3.5" />}
                        </Button>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        <div className="rounded-lg border bg-muted/30 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Current
                          </div>
                          <div className="mt-1 text-sm font-medium">
                            {formatRuleAmount(rule.lastKnownAmount, rule.assetUnit, network)}
                          </div>
                        </div>
                        <div className="rounded-lg border bg-muted/30 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Threshold
                          </div>
                          <div className="mt-1 text-sm font-medium">
                            {formatRuleAmount(rule.thresholdAmount, rule.assetUnit, network)}
                          </div>
                        </div>
                        <div className="rounded-lg border bg-muted/30 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Last warning
                          </div>
                          <div className="mt-1 text-sm font-medium">
                            {rule.lastAlertedAt ? formatDateTime(rule.lastAlertedAt) : 'None'}
                          </div>
                        </div>
                      </div>

                      {assetMeta.decimals == null && (
                        <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
                          <div>
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Policy ID
                            </div>
                            <div className="mt-1 font-mono text-xs break-all">
                              {assetBreakdown.policyId || 'Missing'}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Asset Name Hex
                            </div>
                            <div className="mt-1 font-mono text-xs break-all">
                              {assetBreakdown.assetNameHex || 'Empty'}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Decoded Name
                            </div>
                            <div className="mt-1 text-xs font-medium">
                              {assetBreakdown.decodedAssetName || 'Unavailable'}
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,220px)] sm:items-end">
                        <div className="space-y-1.5">
                          <div className="text-xs text-muted-foreground">
                            {assetMeta.inputLabel}
                          </div>
                          <Input
                            value={draft.thresholdInput}
                            onChange={(event) =>
                              updateRuleDraft(rule.id, {
                                thresholdInput: event.target.value,
                              })
                            }
                            placeholder={assetMeta.decimals != null ? '5.0' : '5000000'}
                          />
                          <div className="text-[11px] text-muted-foreground">
                            Stored raw amount:{' '}
                            <span className="font-mono text-foreground">
                              {draftRawThreshold ?? 'Invalid input'}
                            </span>
                          </div>
                        </div>
                        <div className="rounded-lg border px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-xs font-medium">Enabled</div>
                              <div className="text-[11px] text-muted-foreground">
                                Toggle monitoring for this asset
                              </div>
                            </div>
                            <Switch
                              checked={draft.enabled}
                              onCheckedChange={(checked) =>
                                updateRuleDraft(rule.id, { enabled: checked })
                              }
                            />
                          </div>
                        </div>
                      </div>

                      {supportsAutoTopup && (
                        <AutoTopupControl
                          checked={draft.topupEnabled}
                          onCheckedChange={(checked) =>
                            updateRuleDraft(rule.id, { topupEnabled: checked })
                          }
                          amountInput={draft.topupAmountInput}
                          onAmountInputChange={(value) =>
                            updateRuleDraft(rule.id, { topupAmountInput: value })
                          }
                          assetLabel={assetMeta.label}
                          placeholder={assetMeta.decimals != null ? '50.0' : '50000000'}
                          error={draftTopupValidation.error}
                          rawAmount={draftRawTopup}
                          ariaLabel="Toggle auto top-up"
                        />
                      )}

                      <div className="flex justify-end">
                        <Button
                          variant="outline"
                          className="w-full sm:w-auto sm:min-w-24"
                          onClick={() => onSaveRule(rule)}
                          disabled={
                            !hasChanges || isMutating || draftRawThreshold == null || topupInvalid
                          }
                        >
                          {isMutating ? <Spinner size={16} /> : 'Save rule'}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="rounded-xl border border-dashed bg-background/70 p-4">
            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-semibold">Add monitoring rule</h4>
              <p className="text-xs text-muted-foreground">
                Pick a common asset or switch to custom for a full policy+asset unit.
              </p>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Asset</div>
                <Select
                  value={newRuleAssetPreset}
                  onValueChange={(value) => {
                    setNewRuleAssetPreset(value as RuleAssetPreset);
                    setNewRuleThresholdInput('');
                    setNewRuleTopupAmountInput('');
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select asset" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lovelace">ADA</SelectItem>
                    <SelectItem value="stablecoin">
                      {network === 'Mainnet' ? 'USDCx' : 'tUSDM'}
                    </SelectItem>
                    <SelectItem value="custom">Custom asset</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">{addRuleAssetMeta.inputLabel}</div>
                <Input
                  value={newRuleThresholdInput}
                  onChange={(event) => setNewRuleThresholdInput(event.target.value)}
                  placeholder={addRuleAssetMeta.decimals != null ? '5.0' : '5000000'}
                />
                <div className="text-[11px] text-muted-foreground">
                  {addRuleAssetMeta.decimals != null
                    ? `Will be stored with ${addRuleAssetMeta.decimals} decimals for ${addRuleAssetMeta.label}.`
                    : addRuleAssetMeta.helperText}
                </div>
              </div>
            </div>

            {newRuleAssetPreset === 'custom' && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">Custom asset unit</div>
                  <Input
                    value={newRuleCustomAssetUnit}
                    onChange={(event) => setNewRuleCustomAssetUnit(event.target.value)}
                    placeholder="policyidassetnamehex"
                  />
                  <div className="text-[11px] leading-relaxed text-muted-foreground">
                    Format:{' '}
                    <span className="font-mono text-foreground">policyId + assetNameHex</span>.
                    Example field shape:{' '}
                    <span className="font-mono text-foreground">policyidassetnamehex</span>
                  </div>
                </div>

                <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Policy ID
                    </div>
                    <div className="mt-1 font-mono text-xs break-all">
                      {newRuleAssetBreakdown.policyId || 'Enter asset unit'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Asset Name Hex
                    </div>
                    <div className="mt-1 font-mono text-xs break-all">
                      {newRuleAssetBreakdown.assetNameHex || 'Enter asset unit'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Decoded Name
                    </div>
                    <div className="mt-1 text-xs font-medium">
                      {newRuleAssetBreakdown.decodedAssetName || 'Unavailable'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {supportsAutoTopup && (
              <div className="mt-4">
                <AutoTopupControl
                  checked={newRuleTopupEnabled}
                  onCheckedChange={setNewRuleTopupEnabled}
                  amountInput={newRuleTopupAmountInput}
                  onAmountInputChange={setNewRuleTopupAmountInput}
                  assetLabel={addRuleAssetMeta.label}
                  placeholder={addRuleAssetMeta.decimals != null ? '50.0' : '50000000'}
                  error={newRuleTopupError}
                  rawAmount={newRuleRawTopup}
                  ariaLabel="Enable auto top-up for new rule"
                />
              </div>
            )}

            <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_200px_auto] lg:items-end">
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Raw amount preview
                </div>
                <div className="mt-1 font-mono text-sm">
                  {newRuleThresholdInput.trim() === ''
                    ? 'Enter amount'
                    : (newRuleRawThreshold ?? 'Invalid input')}
                </div>
              </div>
              <div className="rounded-lg border px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium">Enabled</div>
                    <div className="text-[11px] text-muted-foreground">
                      Start monitoring immediately
                    </div>
                  </div>
                  <Switch checked={newRuleEnabled} onCheckedChange={setNewRuleEnabled} />
                </div>
              </div>
              <Button
                className="w-full lg:w-auto"
                onClick={onCreateRule}
                disabled={isCreatingRule || !canCreateNewRule}
              >
                {isCreatingRule ? <Spinner size={16} /> : 'Add rule'}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
