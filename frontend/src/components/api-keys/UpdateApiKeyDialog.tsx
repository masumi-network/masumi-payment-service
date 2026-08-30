import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useState, useRef, useMemo, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { patchApiKey } from '@/lib/api/generated';
import { useX402Networks } from '@/lib/hooks/useX402';
import { toast } from 'react-toastify';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PatchApiKeyData, PatchApiKeyResponse } from '@/lib/api/generated/types.gen';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Checkbox } from '@/components/ui/checkbox';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { X402WalletScopeField } from '@/components/api-keys/X402WalletScopeField';
import { useAllWallets } from '@/lib/queries/useWallets';
import { shortenAddress } from '@/lib/utils';
import {
  convertBaseUnitsToDecimal,
  convertDecimalToBaseUnits,
  isValidDecimalAmount,
} from '@/lib/convertDecimalToBaseUnits';
import {
  consolidateCreditRows,
  creditDeltas,
  creditUnitOptionsForKey,
} from '@/lib/api-key-credit-units';
import { UsageCreditsField, type CreditRow } from '@/components/api-keys/UsageCreditsField';
import { Switch } from '@/components/ui/switch';

interface UpdateApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  apiKey: {
    id: string;
    token: string;
    // Flag-based permissions
    canRead: boolean;
    canPay: boolean;
    canAdmin: boolean;
    // Legacy permission (for display)
    permission: 'Read' | 'ReadAndPay' | 'Admin';
    NetworkLimit: Array<'Preprod' | 'Mainnet'>;
    ChainIdLimit: string[];
    usageLimited: boolean;
    RemainingUsageCredits: Array<{ unit: string; amount: string }>;
    status: 'Active' | 'Revoked';
    walletScopeEnabled: boolean;
    WalletScopes: Array<{ hotWalletId: string }>;
    x402WalletScopeEnabled: boolean;
    X402WalletScopes: Array<{ evmWalletId: string }>;
  };
}

/**
 * Built per key rather than once at module scope, because two of its rules depend on
 * what the ledger already holds: a zero balance is only expressible for a unit that
 * already has a row.
 */
function buildUpdateApiKeySchema(fundedUnits: Set<string>) {
  return z
    .object({
      newToken: z
        .string()
        .min(15, 'Token must be at least 15 characters')
        .optional()
        .or(z.literal('')),
      status: z.enum(['Active', 'Revoked']),
      usageLimited: z.boolean(),
      credits: z.array(z.object({ unit: z.string(), amount: z.string(), decimals: z.number() })),
      walletScopeEnabled: z.boolean(),
      walletScopeIds: z.array(z.string()),
      x402WalletScopeEnabled: z.boolean(),
      x402WalletScopeIds: z.array(z.string()),
      evmChains: z.array(z.string()),
    })
    .superRefine((val, ctx) => {
      // The balances are hidden while the cap is off, and an uncapped key ignores them.
      // Validating them anyway blocked Update with an error rendered only inside the
      // unmounted field, so the button looked dead and no request was made.
      if (!val.usageLimited) return;
      val.credits.forEach((credit, index) => {
        if (credit.amount.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Enter a balance, or remove this unit',
            path: ['credits', index, 'amount'],
          });
          return;
        }
        // Balances, not deltas: a negative balance is meaningless and the server
        // rejects it anyway. Precision is checked against the unit's own decimals so
        // an over-precise entry is refused instead of silently truncated on convert.
        if (!isValidDecimalAmount(credit.amount, { decimals: credit.decimals })) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              credit.decimals === 0
                ? 'Enter a whole number of base units'
                : `Enter a positive amount with at most ${credit.decimals} decimals`,
            path: ['credits', index, 'amount'],
          });
          return;
        }
        // A zero balance for a unit the ledger has no row for sends no delta at all
        // (creditDeltas skips it) and the server refuses to create one (400 'Invalid
        // amount'). The save would report success and leave the unit uncapped, which
        // for x402 means the key keeps spending with no ceiling.
        if (
          !fundedUnits.has(credit.unit) &&
          convertDecimalToBaseUnits(credit.amount, credit.decimals) === '0'
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Enter an amount above zero. The node cannot store a new unit at zero.',
            path: ['credits', index, 'amount'],
          });
        }
      });
      // The exact state that broke every purchase on this deployment: a key flagged
      // usage-limited whose ledger has no row for the unit it pays in fails the credit
      // gate with `Credit unit not found`, surfaced to the buyer as a bare 400
      // 'Insufficient funds' with no purchase ever created.
      if (val.usageLimited && val.credits.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'A usage-limited key needs at least one funded unit, or every payment it makes is rejected.',
          path: ['credits'],
        });
      }
    });
}

type UpdateApiKeyFormValues = z.infer<ReturnType<typeof buildUpdateApiKeySchema>>;

/**
 * Get a human-readable permission label from flags.
 */
function getPermissionLabel(_canRead: boolean, canPay: boolean, canAdmin: boolean): string {
  if (canAdmin) return 'Admin';
  if (canPay) return 'Read and Pay';
  return 'Read Only';
}

export function UpdateApiKeyDialog({ open, onClose, onSuccess, apiKey }: UpdateApiKeyDialogProps) {
  const [showToken, setShowToken] = useState(false);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const { apiClient } = useAppContext();

  const updateApiKey = useApiMutation({
    mutationFn: (body: NonNullable<PatchApiKeyData['body']>) =>
      patchApiKey({ client: apiClient, body }),
    errorMessage: 'Failed to update API key',
  });
  const isLoading = updateApiKey.isPending;
  const { paymentSources } = usePaymentSourceExtendedAll();
  const { wallets: managedWallets } = useAllWallets(open);
  // A key's NetworkLimit can span both Cardano networks, so offer EVM chains from every
  // environment, not just the active top-selector one, or chains for the other network
  // can't be added to ChainIdLimit in one flow.
  const { networks: evmChainOptions } = useX402Networks({
    silentErrors: true,
    allEnvironments: true,
  });

  const allWallets = useMemo(() => {
    // Wallets come from /wallet/list now; join to the source for its network.
    const networkBySourceId = new Map(paymentSources.map((ps) => [ps.id, ps.network]));
    return managedWallets.map((wallet) => ({
      id: wallet.id,
      type: wallet.type,
      network: networkBySourceId.get(wallet.paymentSourceId) ?? '',
      walletAddress: wallet.walletAddress,
      note: wallet.note,
    }));
  }, [managedWallets, paymentSources]);

  // One editable row per unit, not per stored row: the ledger can hold duplicates for
  // the same unit and every consumer below assumes a unit appears once.
  const currentCredits = useMemo(
    () => consolidateCreditRows(apiKey.RemainingUsageCredits),
    [apiKey.RemainingUsageCredits],
  );

  // Offer the units this key can actually spend. The form used to hard-code ADA plus
  // the "active stablecoin", which on Mainnet is USDCx: a key paying in USDM could not
  // be funded for the asset it spends, and an EVM key could not be funded at all.
  const creditOptions = useMemo(
    () =>
      creditUnitOptionsForKey({
        networkLimit: apiKey.NetworkLimit,
        chainIdLimit: apiKey.ChainIdLimit,
        evmNetworks: evmChainOptions,
        existingUnits: currentCredits.map((credit) => credit.unit),
      }),
    [apiKey.NetworkLimit, apiKey.ChainIdLimit, currentCredits, evmChainOptions],
  );

  // Seed with the key's stored balances so the dialog shows the ledger it edits. The
  // old fields were always blank deltas, so the form could never say whether a key was
  // funded at all.
  const initialCreditRows = useMemo<CreditRow[]>(
    () =>
      currentCredits.map((credit) => {
        // 0 for anything no preset describes, so the stored value round-trips exactly
        // instead of being rescaled by an assumed 6dp.
        const decimals = creditOptions.find((option) => option.unit === credit.unit)?.decimals ?? 0;
        let amount = credit.amount;
        try {
          amount = convertBaseUnitsToDecimal(credit.amount, decimals);
        } catch {
          // Leave an unparseable stored value visible rather than dropping the row.
        }
        return { unit: credit.unit, amount, decimals };
      }),
    [currentCredits, creditOptions],
  );

  const updateApiKeySchema = useMemo(
    () => buildUpdateApiKeySchema(new Set(currentCredits.map((credit) => credit.unit))),
    [currentCredits],
  );

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors, dirtyFields },
  } = useForm<UpdateApiKeyFormValues>({
    resolver: zodResolver(updateApiKeySchema),
    defaultValues: {
      newToken: '',
      status: apiKey.status,
      usageLimited: apiKey.usageLimited,
      credits: initialCreditRows,
      walletScopeEnabled: apiKey.walletScopeEnabled,
      walletScopeIds: apiKey.WalletScopes.map((ws) => ws.hotWalletId),
      x402WalletScopeEnabled: apiKey.x402WalletScopeEnabled,
      x402WalletScopeIds: apiKey.X402WalletScopes.map((ws) => ws.evmWalletId),
      evmChains: apiKey.ChainIdLimit.filter((chainId) => chainId.startsWith('eip155:')),
    },
  });

  const walletScopeEnabled = useWatch({
    control,
    name: 'walletScopeEnabled',
    defaultValue: apiKey.walletScopeEnabled,
  });
  const walletScopeIds = useWatch({
    control,
    name: 'walletScopeIds',
    defaultValue: apiKey.WalletScopes.map((ws) => ws.hotWalletId),
  });
  const x402WalletScopeEnabled = useWatch({
    control,
    name: 'x402WalletScopeEnabled',
    defaultValue: apiKey.x402WalletScopeEnabled,
  });
  const x402WalletScopeIds = useWatch({
    control,
    name: 'x402WalletScopeIds',
    defaultValue: apiKey.X402WalletScopes.map((ws) => ws.evmWalletId),
  });

  const usageLimited = useWatch({
    control,
    name: 'usageLimited',
    defaultValue: apiKey.usageLimited,
  });
  const creditRows = useWatch({ control, name: 'credits', defaultValue: initialCreditRows });

  // The EVM chain list loads after first paint, so the defaults above fall back to base
  // units for any chain-qualified unit. Re-seed once the real decimals are known, but
  // only while the operator has not started editing, so this can never eat their input.
  const seededCreditsRef = useRef<string | null>(null);
  const creditsDirty = dirtyFields.credits !== undefined;
  useEffect(() => {
    // dirtyFields.credits, not isDirty: the latter is form-wide, so typing a new token
    // before the chain list arrived froze every chain-qualified row at the base-unit
    // fallback while the label resolved to the preset, showing 5000000 next to USDC.
    if (creditsDirty) return;
    const signature = initialCreditRows.map((row) => `${row.unit}:${row.decimals}`).join('|');
    if (signature === seededCreditsRef.current) return;
    seededCreditsRef.current = signature;
    setValue('credits', initialCreditRows);
  }, [initialCreditRows, creditsDirty, setValue]);

  // react-hook-form nests array errors as errors.credits[index].amount; flatten them to
  // the index map the field component renders.
  const creditRowErrors = useMemo<Record<number, string | undefined>>(() => {
    const creditErrors = errors.credits;
    if (!Array.isArray(creditErrors)) return {};
    const flattened: Record<number, string | undefined> = {};
    creditErrors.forEach((entry, index) => {
      const message = entry?.amount?.message;
      if (typeof message === 'string') flattened[index] = message;
    });
    return flattened;
  }, [errors.credits]);

  const onSubmit = async (data: UpdateApiKeyFormValues) => {
    // The endpoint takes deltas, not absolute balances, so diff the edited balances
    // against the stored ones and send only what moved. An unchanged unit is omitted;
    // a zero delta for a unit with no row is a 400 ('Invalid amount').
    // Only while the cap is on. With it off the balances are neither validated nor
    // shown, so a half-typed row would throw here (convertDecimalToBaseUnits rejects
    // an empty string and handleSubmit re-throws, leaving the button dead), and a
    // cleared list would send deltas that zero the ledger from a hidden section.
    const usageCredits = data.usageLimited
      ? creditDeltas(
          currentCredits,
          data.credits.map((credit) => ({
            unit: credit.unit,
            amount: convertDecimalToBaseUnits(credit.amount, credit.decimals),
          })),
        )
      : [];

    const walletScopeChanged =
      data.walletScopeEnabled !== apiKey.walletScopeEnabled ||
      JSON.stringify([...data.walletScopeIds].sort()) !==
        JSON.stringify([...apiKey.WalletScopes.map((ws) => ws.hotWalletId)].sort());

    const x402WalletScopeChanged =
      data.x402WalletScopeEnabled !== apiKey.x402WalletScopeEnabled ||
      JSON.stringify([...data.x402WalletScopeIds].sort()) !==
        JSON.stringify([...apiKey.X402WalletScopes.map((ws) => ws.evmWalletId)].sort());

    const initialEvmChains = apiKey.ChainIdLimit.filter((chainId) => chainId.startsWith('eip155:'));
    const evmChainsChanged =
      JSON.stringify([...data.evmChains].sort()) !== JSON.stringify([...initialEvmChains].sort());

    const response = await updateApiKey
      .mutateAsync({
        id: apiKey.id,
        ...(data.newToken && { token: data.newToken }),
        ...(data.status !== apiKey.status && { status: data.status }),
        ...(usageCredits.length > 0 && {
          UsageCreditsToAddOrRemove: usageCredits,
        }),
        ...(data.usageLimited !== apiKey.usageLimited && {
          usageLimited: data.usageLimited,
        }),
        ...(walletScopeChanged && {
          walletScopeEnabled: data.walletScopeEnabled,
          WalletScopeHotWalletIds: data.walletScopeEnabled ? data.walletScopeIds : [],
        }),
        ...(x402WalletScopeChanged && {
          x402WalletScopeEnabled: data.x402WalletScopeEnabled,
          X402WalletScopeEvmWalletIds: data.x402WalletScopeEnabled ? data.x402WalletScopeIds : [],
        }),
        ...(!apiKey.canAdmin &&
          evmChainsChanged && {
            // Any non-admin key may have its EVM grant edited — read keys need it
            // for the x402 read surfaces too; gating this on canPay left read keys
            // created with an empty grant permanently unrepairable from the UI.
            //
            // Send ONLY the EVM half. apiKey.ChainIdLimit is the whole networkLimit
            // column, Cardano entries included, but the endpoint rejects any
            // `cardano:` id here ("Use NetworkLimit for Cardano networks") — so
            // echoing them back 400'd every attempt and no chain grant could ever
            // be changed from this dialog. The server merges this half with the
            // untouched Cardano half itself.
            ChainIdLimit: data.evmChains,
          }),
      })
      .catch(() => null);
    if (!response) return;

    const responseData = response?.data as PatchApiKeyResponse;
    if (!responseData?.data?.id) {
      toast.error('Failed to update API key: Invalid response from server');
      return;
    }
    toast.success('API key updated successfully');
    onSuccess();
    handleClose();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update API key</DialogTitle>
        </DialogHeader>

        {/* Wraps rather than shrinks: as one no-wrap flex row, a narrow dialog squeezed
            every child below its content width and the badges broke mid-word
            ("Read and / Pay", "Mainne / t"). */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border bg-muted/50 px-3 py-2.5 text-sm">
          <span className="shrink-0 text-muted-foreground">Permission:</span>
          <Badge
            variant={apiKey.canAdmin ? 'default' : apiKey.canPay ? 'secondary' : 'outline'}
            className="whitespace-nowrap"
          >
            {getPermissionLabel(apiKey.canRead, apiKey.canPay, apiKey.canAdmin)}
          </Badge>
          <Separator orientation="vertical" className="mx-1 h-4 max-sm:hidden" />
          <span className="shrink-0 text-muted-foreground">Networks:</span>
          <div className="flex flex-wrap gap-1">
            {apiKey.NetworkLimit.map((net) => (
              <Badge key={net} variant="outline" className="font-normal whitespace-nowrap">
                {net}
              </Badge>
            ))}
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          {/* Display current permission level */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Permission Level</label>
            <div className="p-2 bg-muted rounded-md text-sm">
              {getPermissionLabel(apiKey.canRead, apiKey.canPay, apiKey.canAdmin)}
            </div>
            <p className="text-xs text-muted-foreground">
              Permission level cannot be changed after creation
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">New Token (Optional)</label>
            <div className="relative">
              <Input
                type={showToken ? 'text' : 'password'}
                placeholder="Leave empty to keep current token"
                {...register('newToken')}
                ref={(el) => {
                  tokenInputRef.current = el;
                  const { ref } = register('newToken');
                  if (typeof ref === 'function') ref(el);
                }}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowToken((v) => !v)}
                tabIndex={-1}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {errors.newToken && (
              <p className="text-xs text-destructive mt-1">{errors.newToken.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Must be at least 15 characters if provided
            </p>
          </div>

          {!apiKey.canAdmin && evmChainOptions.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">EVM chains (x402)</label>
              <p className="text-xs text-muted-foreground">
                Chains this key may settle and fetch x402 payments on.
              </p>
              <Controller
                control={control}
                name="evmChains"
                render={({ field }) => {
                  // Membership, not count: ChainIdLimit can still name a chain this node
                  // no longer configures, which makes the two counts match while the
                  // boxes below disagree. Clicking "all" then took the already-all
                  // branch and cleared every EVM grant on the key.
                  const allEvmChainsSelected = evmChainOptions.every((chain) =>
                    field.value.includes(chain.caip2Id),
                  );
                  return (
                    <div className="flex flex-col gap-2">
                      {/* Named for what it does. The node stores no "unlimited" state:
                        an omitted ChainIdLimit is expanded to the configured chain list
                        at creation (routes/api/api-key/index.ts), and on PATCH an omitted
                        one means unchanged. So "all" is a snapshot of today's chains, and
                        a chain configured later is not granted by it. */}
                      <div className="flex items-center gap-2">
                        <Checkbox
                          aria-label="Select all EVM chains"
                          // Not 'indeterminate': the shared Checkbox styles only
                          // data-[state=checked] and always renders its Check icon, so a
                          // partial state paints a tick with no fill and reads as checked.
                          checked={allEvmChainsSelected}
                          onCheckedChange={() =>
                            field.onChange(
                              allEvmChainsSelected
                                ? []
                                : evmChainOptions.map((chain) => chain.caip2Id),
                            )
                          }
                        />
                        <label className="text-sm font-medium">
                          All EVM chains configured on this node
                        </label>
                      </div>
                      <Separator className="my-1" />
                      {evmChainOptions.map((chain) => (
                        <div key={chain.id} className="flex items-center gap-2">
                          <Checkbox
                            aria-label={chain.displayName}
                            checked={field.value.includes(chain.caip2Id)}
                            onCheckedChange={() => {
                              if (field.value.includes(chain.caip2Id)) {
                                field.onChange(
                                  field.value.filter((c: string) => c !== chain.caip2Id),
                                );
                              } else {
                                field.onChange([...field.value, chain.caip2Id]);
                              }
                            }}
                          />
                          <label className="text-sm">
                            {chain.displayName}{' '}
                            <span className="font-mono text-xs text-muted-foreground">
                              {chain.caip2Id}
                            </span>
                          </label>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger aria-label="Status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Revoked">Revoked</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {errors.status && (
              <p className="text-xs text-destructive mt-1">{errors.status.message}</p>
            )}
          </div>

          {apiKey.canAdmin ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Spending limit</label>
              <p className="text-xs text-muted-foreground">
                Admin keys are never usage limited, so they hold no credit balances.
              </p>
            </div>
          ) : (
            <>
              {/* Same shape as every other switch in the app (ChainsTab,
                  FundWalletSettingsForm): a bordered row, label left, control right. */}
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Limit usage credits</p>
                  <p className="text-xs text-muted-foreground">
                    {usageLimited
                      ? 'Capped. The key spends only the balances below, and any other unit is rejected.'
                      : 'Uncapped. The key spends whatever the wallets it can reach hold.'}
                  </p>
                </div>
                <Controller
                  control={control}
                  name="usageLimited"
                  render={({ field }) => (
                    <Switch
                      aria-label="Limit usage credits"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>

              {/* Only meaningful while the cap is on: an uncapped key ignores these
                  balances entirely, so showing them invites edits that do nothing. */}
              {usageLimited && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Usage credits</label>
                  <Controller
                    control={control}
                    name="credits"
                    render={({ field }) => (
                      <UsageCreditsField
                        options={creditOptions}
                        rows={field.value}
                        current={currentCredits}
                        onChange={field.onChange}
                        rowErrors={creditRowErrors}
                      />
                    )}
                  />
                  {/* Shown from the watched values rather than read out of the resolver's
                      array-root error, so the reason a save is blocked is always visible. */}
                  {creditRows.length === 0 && (
                    <p className="text-xs text-destructive">
                      A usage-limited key needs at least one funded unit. With none, the node
                      rejects every purchase with &quot;Insufficient funds&quot; before it writes a
                      payment.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {!apiKey.canAdmin && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Controller
                    control={control}
                    name="walletScopeEnabled"
                    render={({ field }) => (
                      <Checkbox
                        aria-label="Restrict to specific wallets"
                        checked={field.value}
                        onCheckedChange={(checked) => {
                          field.onChange(checked);
                          if (!checked) {
                            setValue('walletScopeIds', []);
                          }
                        }}
                      />
                    )}
                  />
                  <label className="text-sm font-medium">Restrict to specific wallets</label>
                </div>
                <p className="text-xs text-muted-foreground">
                  When enabled, this API key can only access data for the selected wallets.
                </p>
              </div>

              {walletScopeEnabled && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Wallets in scope</label>
                  <div className="border rounded-md max-h-48 overflow-y-auto">
                    {allWallets.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-3">No wallets available</p>
                    ) : (
                      allWallets.map((wallet) => (
                        <label
                          key={wallet.id}
                          className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 cursor-pointer border-b last:border-b-0"
                        >
                          <Checkbox
                            checked={walletScopeIds.includes(wallet.id)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setValue('walletScopeIds', [...walletScopeIds, wallet.id]);
                              } else {
                                setValue(
                                  'walletScopeIds',
                                  walletScopeIds.filter((id) => id !== wallet.id),
                                );
                              }
                            }}
                          />
                          <span className="flex items-center gap-2 min-w-0">
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                              {wallet.type}
                            </Badge>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {wallet.network}
                            </span>
                            <span className="font-mono text-xs truncate">
                              {shortenAddress(wallet.walletAddress)}
                            </span>
                            {wallet.note && (
                              <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                                ({wallet.note})
                              </span>
                            )}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                  {walletScopeIds.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {walletScopeIds.length} wallet{walletScopeIds.length !== 1 ? 's' : ''}{' '}
                      selected
                    </p>
                  )}
                </div>
              )}

              <X402WalletScopeField
                active={open}
                enabled={x402WalletScopeEnabled}
                onEnabledChange={(next) => setValue('x402WalletScopeEnabled', next)}
                selectedIds={x402WalletScopeIds}
                onSelectedIdsChange={(ids) => setValue('x402WalletScopeIds', ids)}
              />
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading} onClick={handleSubmit(onSubmit)}>
            {isLoading ? 'Updating...' : 'Update'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
