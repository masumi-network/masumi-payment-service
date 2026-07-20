import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Trash2, Plus } from 'lucide-react';
import {
  Controller,
  type Control,
  type FieldArrayWithId,
  type FieldErrors,
  type UseFormRegister,
  type UseFormWatch,
} from 'react-hook-form';
import type { X402AvailableNetwork, X402Wallet } from '@/lib/api/generated';
import { formatFundUnit } from '@/lib/utils';
import { REGISTRY_LIMITS } from '@/lib/registry-validation';
import type { X402OptionDraft } from '@/lib/x402-registration';
import {
  MAX_PAYMENT_OPTIONS,
  type MasumiOptionDraft,
  type MasumiPriceUnit,
  type MasumiStablecoinUnit,
  type PaymentConfigurationType,
  type PaymentOptionRow,
} from '@/lib/agent-registration';
import { X402OptionFields } from './X402OptionsSection';
import { MasumiOptionFields } from './MasumiOptionFields';
import type { AgentFormValues } from './register-agent-schema';

type OptionError = {
  message: string;
  optionId?: string;
} | null;

/**
 * The "Payment options" block of the register/update dialog: the option rows
 * (Masumi escrow and x402 direct settlement), the add/remove/type controls,
 * and the section-level validation banners. Pure view — option state and the
 * V1 legacy pricing form fields are owned by the dialog.
 */
export function PaymentOptionsSection({
  rows,
  masumiOptions,
  x402Options,
  masumiError,
  x402Error,
  isV2Target,
  network,
  stablecoinUnit,
  defaultPriceUnit,
  x402Networks,
  x402Wallets,
  isLoadingX402Wallets,
  onAddOption,
  onChangeOptionType,
  onRemoveOption,
  onMasumiOptionChange,
  onX402OptionChange,
  control,
  watch,
  errors,
  register,
  priceFields,
  appendPrice,
  removePrice,
  replacePrices,
}: {
  rows: PaymentOptionRow[];
  masumiOptions: MasumiOptionDraft[];
  x402Options: X402OptionDraft[];
  masumiError: OptionError;
  x402Error: OptionError;
  isV2Target: boolean;
  network: 'Mainnet' | 'Preprod';
  stablecoinUnit: MasumiStablecoinUnit;
  defaultPriceUnit: MasumiPriceUnit;
  x402Networks: X402AvailableNetwork[];
  x402Wallets: X402Wallet[];
  isLoadingX402Wallets: boolean;
  onAddOption: () => void;
  onChangeOptionType: (row: PaymentOptionRow, nextType: PaymentConfigurationType) => void;
  onRemoveOption: (row: PaymentOptionRow) => void;
  onMasumiOptionChange: (option: MasumiOptionDraft) => void;
  onX402OptionChange: (id: string, patch: Partial<X402OptionDraft>) => void;
  // V1 legacy pricing lives in the top-level form; the RHF plumbing for it is
  // passed through so this section can render the legacy editor.
  control: Control<AgentFormValues>;
  watch: UseFormWatch<AgentFormValues>;
  errors: FieldErrors<AgentFormValues>;
  register: UseFormRegister<AgentFormValues>;
  priceFields: FieldArrayWithId<AgentFormValues, 'prices', 'id'>[];
  appendPrice: (price: AgentFormValues['prices'][number]) => void;
  removePrice: (index: number) => void;
  replacePrices: (prices: AgentFormValues['prices']) => void;
}) {
  const hasMasumiPaymentOption = rows.some((option) => option.type === 'Masumi');

  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="payment-options-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 id="payment-options-heading" className="text-base font-semibold">
              Payment options
            </h3>
            <Badge variant="secondary" className="font-normal text-muted-foreground">
              {rows.length} {rows.length === 1 ? 'option' : 'options'}
            </Badge>
          </div>
          <p className="max-w-[65ch] text-sm text-muted-foreground">
            Offer Masumi escrow, x402 direct settlement, or both.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAddOption}
          disabled={rows.length >= MAX_PAYMENT_OPTIONS || !isV2Target}
        >
          <Plus data-icon="inline-start" />
          Add payment option
        </Button>
      </div>

      {!isV2Target ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Additional payment options (x402 direct settlement) require an active Web3 Cardano V2
          payment source. V1 registrations support a single Masumi option.
        </p>
      ) : null}
      {!isV2Target && x402Options.length > 0 ? (
        <p
          role="status"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          x402 options require an active Web3 Cardano V2 payment source.
        </p>
      ) : null}
      {x402Options.length > 0 && x402Networks.length === 0 ? (
        <p
          role="status"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          Configure an EVM chain in x402 setup before registering this agent.
        </p>
      ) : null}
      {rows.length >= MAX_PAYMENT_OPTIONS ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          The on-chain limit allows 25 payment options in total.
        </p>
      ) : null}
      {x402Error && !x402Error.optionId ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {x402Error.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        {rows.map((optionRow, optionIndex) => {
          const x402Option =
            optionRow.type === 'x402'
              ? x402Options.find((option) => option.id === optionRow.id)
              : undefined;
          const masumiOption =
            optionRow.type === 'Masumi'
              ? masumiOptions.find((option) => option.id === optionRow.id)
              : undefined;

          return (
            <article
              key={optionRow.id}
              className="overflow-hidden rounded-lg border bg-card/40"
              aria-labelledby={`payment-option-${optionRow.id}`}
            >
              <div className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <h4 id={`payment-option-${optionRow.id}`} className="text-sm font-semibold">
                    Payment option {optionIndex + 1}
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    {optionRow.type === 'Masumi'
                      ? 'Escrow settlement with dispute support.'
                      : x402Option?.pricingType === 'Fixed'
                        ? 'An exact amount and asset stored in the registry.'
                        : x402Option?.pricingType === 'Free'
                          ? 'No payment is required for this x402 resource.'
                          : 'The exact amount is supplied at runtime.'}
                  </p>
                </div>

                <div className="flex w-full items-end gap-2 sm:w-auto">
                  <div className="min-w-0 flex-1 space-y-1 sm:w-56 sm:flex-none">
                    <label className="text-xs font-medium text-muted-foreground">
                      Payment type
                    </label>
                    <Select
                      value={optionRow.type}
                      onValueChange={(value) => {
                        if (value === 'Masumi' || value === 'x402') {
                          onChangeOptionType(optionRow, value);
                        }
                      }}
                    >
                      <SelectTrigger
                        className="h-9 bg-background"
                        aria-label={`Payment type for option ${optionIndex + 1}`}
                      >
                        <SelectValue placeholder="Select a payment type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem
                            value="Masumi"
                            disabled={
                              !isV2Target && hasMasumiPaymentOption && optionRow.type !== 'Masumi'
                            }
                          >
                            Disputable (Masumi)
                          </SelectItem>
                          {/* x402 sources can only be advertised by V2
                              registrations — a V1 x402 row could never
                              submit, so don't offer it. */}
                          <SelectItem value="x402" disabled={!isV2Target}>
                            x402 direct settlement
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  {rows.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 shrink-0 sm:h-9 sm:w-9"
                      aria-label={`Remove payment option ${optionIndex + 1}`}
                      onClick={() => onRemoveOption(optionRow)}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="space-y-4 p-4">
                {optionRow.type === 'Masumi' ? (
                  isV2Target && masumiOption ? (
                    <>
                      <MasumiOptionFields
                        option={masumiOption}
                        optionNumber={optionIndex + 1}
                        network={network}
                        stablecoinUnit={stablecoinUnit}
                        defaultPriceUnit={defaultPriceUnit}
                        onChange={onMasumiOptionChange}
                      />
                      {masumiError?.optionId === optionRow.id ? (
                        <p
                          role="alert"
                          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                        >
                          {masumiError.message}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <LegacyMasumiPricingFields
                      optionNumber={optionIndex + 1}
                      network={network}
                      stablecoinUnit={stablecoinUnit}
                      defaultPriceUnit={defaultPriceUnit}
                      control={control}
                      watch={watch}
                      errors={errors}
                      register={register}
                      priceFields={priceFields}
                      appendPrice={appendPrice}
                      removePrice={removePrice}
                      replacePrices={replacePrices}
                    />
                  )
                ) : x402Option ? (
                  <>
                    <X402OptionFields
                      option={x402Option}
                      optionNumber={optionIndex + 1}
                      networks={x402Networks}
                      wallets={x402Wallets}
                      isLoadingWallets={isLoadingX402Wallets}
                      hasError={x402Error?.optionId === optionRow.id}
                      onChange={(patch) => onX402OptionChange(optionRow.id, patch)}
                    />
                    {x402Error?.optionId === optionRow.id ? (
                      <p
                        role="alert"
                        className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                      >
                        {x402Error.message}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Preparing x402 settings…</p>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * V1 legacy pricing editor: the single top-level `pricingType` + `prices`
 * form fields (source-owned per-option pricing is V2-only).
 */
function LegacyMasumiPricingFields({
  optionNumber,
  network,
  stablecoinUnit,
  defaultPriceUnit,
  control,
  watch,
  errors,
  register,
  priceFields,
  appendPrice,
  removePrice,
  replacePrices,
}: {
  optionNumber: number;
  network: 'Mainnet' | 'Preprod';
  stablecoinUnit: MasumiStablecoinUnit;
  defaultPriceUnit: MasumiPriceUnit;
  control: Control<AgentFormValues>;
  watch: UseFormWatch<AgentFormValues>;
  errors: FieldErrors<AgentFormValues>;
  register: UseFormRegister<AgentFormValues>;
  priceFields: FieldArrayWithId<AgentFormValues, 'prices', 'id'>[];
  appendPrice: (price: AgentFormValues['prices'][number]) => void;
  removePrice: (index: number) => void;
  replacePrices: (prices: AgentFormValues['prices']) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium">
          Pricing model <span className="text-destructive">*</span>
        </label>
        <Controller
          control={control}
          name="pricingType"
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(value) => {
                field.onChange(value);
                if (value === 'Fixed' && priceFields.length === 0) {
                  replacePrices([{ unit: defaultPriceUnit, amount: '' }]);
                } else if (value !== 'Fixed') {
                  replacePrices([]);
                }
              }}
            >
              <SelectTrigger aria-label={`Pricing model for payment option ${optionNumber}`}>
                <SelectValue placeholder="Select a pricing model" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="Fixed">Fixed price</SelectItem>
                  <SelectItem value="Dynamic">Dynamic per payment</SelectItem>
                  <SelectItem value="Free">Free</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        />
        {watch('pricingType') === 'Dynamic' ? (
          <p className="text-xs text-muted-foreground">
            Your agent sets the amount for each payment request.
          </p>
        ) : null}
        {watch('pricingType') === 'Free' ? (
          <p className="text-xs text-muted-foreground">
            Interactions do not require a Masumi escrow payment.
          </p>
        ) : null}
      </div>

      {watch('pricingType') === 'Fixed' ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-medium">
              Coins and prices <span className="text-destructive">*</span>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={priceFields.length >= REGISTRY_LIMITS.pricingOptionCount}
              onClick={() => appendPrice({ unit: defaultPriceUnit, amount: '' })}
            >
              <Plus data-icon="inline-start" />
              Add coin
            </Button>
          </div>
          {priceFields.map((priceField, index) => (
            <div
              key={priceField.id}
              className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1">
                <Controller
                  control={control}
                  name={`prices.${index}.unit` as const}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label={`Coin for Masumi price ${index + 1}`}>
                        <SelectValue placeholder="Select a coin" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={stablecoinUnit}>{stablecoinUnit}</SelectItem>
                          <SelectItem value="lovelace">
                            {formatFundUnit('lovelace', network)}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="min-w-0 flex-1">
                <Input
                  type="number"
                  inputMode="decimal"
                  aria-label={`Amount for Masumi price ${index + 1}`}
                  placeholder="0.00"
                  onWheel={(event) => event.currentTarget.blur()}
                  value={watch(`prices.${index}.amount`) || ''}
                  {...register(`prices.${index}.amount` as const)}
                  min="0"
                  step="0.000001"
                />
                {errors.prices && Array.isArray(errors.prices) && errors.prices[index]?.amount ? (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.prices[index]?.amount?.message}
                  </p>
                ) : null}
              </div>
              {index > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 self-end sm:h-9 sm:w-9 sm:self-auto"
                  aria-label={`Remove Masumi price ${index + 1}`}
                  onClick={() => removePrice(index)}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}
          {errors.prices && typeof errors.prices.message === 'string' ? (
            <p className="text-sm text-destructive">{errors.prices.message}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
