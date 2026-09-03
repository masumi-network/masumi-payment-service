import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Controller, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import type { WalletListItem } from '@/lib/api/generated';
import { formatAssetAmount, formatFundUnit, shortenAddress } from '@/lib/utils';
import { hasSufficientMintBalance, minMintBalanceAda } from '@/lib/agent-mint';
import type { AgentFormValues } from './register-agent-schema';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { PlusCircle } from 'lucide-react';

/**
 * Wallet-related fields of the register/update dialog: the minting wallet
 * (fixed display in update mode, picker otherwise), the optional holding
 * wallet, and the optional holding-wallet funding amount.
 */
export function RegisterAgentWalletSection({
  isUpdateMode,
  editingAgentWalletAddress,
  control,
  errors,
  register,
  isLoadingWallets,
  sellingWallets,
  hasSelectedWallet,
  recipientWalletOptions,
  selectedRecipientWalletAddress,
  selectedWalletVkey,
  network,
  onTopUp,
}: {
  isUpdateMode: boolean;
  editingAgentWalletAddress: string | undefined;
  control: Control<AgentFormValues>;
  errors: FieldErrors<AgentFormValues>;
  register: UseFormRegister<AgentFormValues>;
  isLoadingWallets: boolean;
  sellingWallets: { wallet: WalletListItem; balance: number }[];
  hasSelectedWallet: boolean;
  recipientWalletOptions: WalletListItem[];
  selectedRecipientWalletAddress: string | undefined;
  selectedWalletVkey: string;
  network: NetworkType;
  onTopUp: (walletAddress: string) => void;
}) {
  const adaUnitLabel = formatFundUnit('lovelace', network);
  const requiredAdaLabel = minMintBalanceAda().toFixed(2);
  const selectedMintWallet = sellingWallets.find((w) => w.wallet.walletVkey === selectedWalletVkey);

  return (
    <>
      {isUpdateMode ? (
        <div className="space-y-2">
          <label className="text-sm font-medium">Minting wallet</label>
          <Input
            value={editingAgentWalletAddress ? shortenAddress(editingAgentWalletAddress) : '—'}
            disabled
          />
          <p className="text-xs text-muted-foreground">
            The wallet currently holding the agent NFT signs the UpdateAction; it cannot be changed
            here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Minting wallet <span className="text-destructive">*</span>
          </label>
          <Controller
            control={control}
            name="selectedWallet"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger
                  disabled={isLoadingWallets}
                  className={`${errors.selectedWallet ? 'border-destructive' : ''} ${isLoadingWallets ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <SelectValue
                    placeholder={
                      isLoadingWallets ? 'Loading wallets...' : 'Select a minting wallet'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {sellingWallets.map((wallet) => {
                    const eligible = hasSufficientMintBalance(wallet.balance);
                    const balanceLabel = formatAssetAmount(wallet.balance, 'lovelace', network);
                    return (
                      <SelectItem key={wallet.wallet.id} value={wallet.wallet.walletVkey}>
                        {wallet.wallet.note
                          ? `${wallet.wallet.note} (${shortenAddress(wallet.wallet.walletAddress)})`
                          : shortenAddress(wallet.wallet.walletAddress)}{' '}
                        — {balanceLabel}
                        {!eligible ? ` (need > ${requiredAdaLabel} ${adaUnitLabel})` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          />
          {errors.selectedWallet && (
            <p className="text-sm text-destructive">{errors.selectedWallet.message}</p>
          )}
          {selectedMintWallet && !hasSufficientMintBalance(selectedMintWallet.balance) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-2 dark:border-amber-900/50 dark:bg-amber-950/20">
              <div>
                <p>
                  <span className="font-medium">
                    {formatAssetAmount(selectedMintWallet.balance, 'lovelace', network)}
                  </span>{' '}
                  available
                </p>
                <p className="text-xs text-muted-foreground">
                  Need more than {requiredAdaLabel} {adaUnitLabel} to mint
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="gap-1"
                onClick={() => onTopUp(selectedMintWallet.wallet.walletAddress)}
              >
                <PlusCircle className="h-3.5 w-3.5" />
                Top up
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-sm font-medium">Holding wallet</label>
        <Controller
          control={control}
          name="recipientWalletAddress"
          render={({ field }) => (
            <Select
              value={field.value || '__default'}
              onValueChange={(value) => field.onChange(value === '__default' ? '' : value)}
            >
              <SelectTrigger
                disabled={isLoadingWallets || !hasSelectedWallet}
                className={isLoadingWallets ? 'opacity-50 cursor-not-allowed' : ''}
              >
                <SelectValue
                  placeholder={
                    !hasSelectedWallet
                      ? 'Select a minting wallet first'
                      : 'Use minting wallet (default)'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">Use minting wallet (default)</SelectItem>
                {recipientWalletOptions.map((wallet) => (
                  <SelectItem key={wallet.id} value={wallet.walletAddress}>
                    {wallet.note
                      ? `${wallet.note} (${shortenAddress(wallet.walletAddress)})`
                      : shortenAddress(wallet.walletAddress)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <p className="text-xs text-muted-foreground">
          Optional. The selected minting wallet still mints and pays fees, while the registry NFT is
          delivered to another managed holding wallet on the same payment source.
        </p>
        {hasSelectedWallet && recipientWalletOptions.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No other managed wallets are available on this payment source.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Holding wallet funding (ADA)</label>
        <Input
          {...register('sendFundingAda')}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.000001"
          placeholder="Optional ADA amount"
          disabled={!selectedRecipientWalletAddress}
          className={errors.sendFundingAda ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">
          Optional. Sends extra ADA with the minted NFT to the selected holding wallet. The current
          minimum NFT funding still applies.
        </p>
        {!selectedRecipientWalletAddress && (
          <p className="text-xs text-muted-foreground">
            Select a holding wallet to set a custom funding amount.
          </p>
        )}
        {errors.sendFundingAda && (
          <p className="text-sm text-destructive">{errors.sendFundingAda.message}</p>
        )}
      </div>
    </>
  );
}
