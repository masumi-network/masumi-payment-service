import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  convertBaseUnitsToDecimal,
  convertDecimalToBaseUnits,
} from '@/lib/convertDecimalToBaseUnits';
import { MIN_TOPUP_ADA } from '@/lib/fund-wallet';

const adaAmount = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((value) => /^\d+(\.\d{1,6})?$/.test(value) && Number(value) > 0, {
      message: `${label} must be a positive ADA amount (max 6 decimals)`,
    });

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    warningThreshold: adaAmount('Warning threshold'),
    criticalThreshold: adaAmount('Critical threshold'),
    // Mirrors the server's PATCH-side floor check, which exists so the floor
    // cannot be bypassed by editing a valid config down afterwards.
    topupAmount: adaAmount('Top-up amount').refine((value) => Number(value) >= MIN_TOPUP_ADA, {
      message: `Top-up amount must be at least ${MIN_TOPUP_ADA} ADA`,
    }),
  })
  .refine((values) => Number(values.criticalThreshold) < Number(values.warningThreshold), {
    message: 'Critical threshold must be below the warning threshold',
    path: ['criticalThreshold'],
  });

type SettingsValues = z.infer<typeof settingsSchema>;

export type FundDistributionConfig = {
  id: string;
  enabled: boolean;
  warningThreshold: string;
  criticalThreshold: string;
  topupAmount: string;
  batchWindowMs: number;
};

export type FundWalletSettingsSubmit = {
  enabled: boolean;
  warningThreshold: string;
  criticalThreshold: string;
  topupAmount: string;
};

export function FundWalletSettingsForm({
  config,
  onSubmit,
  isSubmitting,
}: {
  config: FundDistributionConfig;
  onSubmit: (values: FundWalletSettingsSubmit) => Promise<void>;
  isSubmitting: boolean;
}) {
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isDirty },
  } = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      enabled: config.enabled,
      warningThreshold: convertBaseUnitsToDecimal(config.warningThreshold),
      criticalThreshold: convertBaseUnitsToDecimal(config.criticalThreshold),
      topupAmount: convertBaseUnitsToDecimal(config.topupAmount),
    },
  });

  // Re-seed the form when the server value changes (e.g. after a save, or a
  // refetch triggered by another panel).
  useEffect(() => {
    reset({
      enabled: config.enabled,
      warningThreshold: convertBaseUnitsToDecimal(config.warningThreshold),
      criticalThreshold: convertBaseUnitsToDecimal(config.criticalThreshold),
      topupAmount: convertBaseUnitsToDecimal(config.topupAmount),
    });
  }, [config, reset]);

  const submit = handleSubmit(async (values) => {
    await onSubmit({
      enabled: values.enabled,
      warningThreshold: convertDecimalToBaseUnits(values.warningThreshold),
      criticalThreshold: convertDecimalToBaseUnits(values.criticalThreshold),
      topupAmount: convertDecimalToBaseUnits(values.topupAmount),
    });
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* Controller rather than watch + setValue: the latter reads as a
          library-driven mutation the React Compiler cannot reason about, so it
          bails out of optimising the whole component. */}
      <Controller
        name="enabled"
        control={control}
        render={({ field }) => (
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Automatic distribution</p>
              <p className="text-xs text-muted-foreground">
                {field.value
                  ? 'Low wallets are topped up automatically.'
                  : 'Paused. The wallet keeps its funds; nothing is sent.'}
              </p>
            </div>
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-label="Toggle automatic distribution"
            />
          </div>
        )}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="fund-settings-warning">
            Warning threshold (ADA)
          </label>
          <Input id="fund-settings-warning" {...register('warningThreshold')} />
          {errors.warningThreshold && (
            <p className="text-xs text-destructive">{errors.warningThreshold.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="fund-settings-critical">
            Critical threshold (ADA)
          </label>
          <Input id="fund-settings-critical" {...register('criticalThreshold')} />
          {errors.criticalThreshold && (
            <p className="text-xs text-destructive">{errors.criticalThreshold.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="fund-settings-topup">
          Top-up amount (ADA)
        </label>
        <Input id="fund-settings-topup" {...register('topupAmount')} />
        {errors.topupAmount && (
          <p className="text-xs text-destructive">{errors.topupAmount.message}</p>
        )}
      </div>

      <Button type="submit" disabled={isSubmitting || !isDirty} className="w-full">
        {isSubmitting ? <Spinner size={16} /> : 'Save settings'}
      </Button>
    </form>
  );
}
