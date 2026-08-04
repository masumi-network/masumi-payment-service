import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Controller, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import type { WalletListItem } from '@/lib/api/generated';
import { shortenAddress } from '@/lib/utils';
import type { AgentFormValues } from './register-agent-schema';

const MIN_MINT_BALANCE_LOVELACE = 3000000;

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
}) {
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
                  {sellingWallets.map((wallet) => (
                    <SelectItem
                      disabled={wallet.balance <= MIN_MINT_BALANCE_LOVELACE}
                      key={wallet.wallet.id}
                      value={wallet.wallet.walletVkey}
                    >
                      {wallet.wallet.note
                        ? `${wallet.wallet.note} (${shortenAddress(wallet.wallet.walletAddress)})`
                        : shortenAddress(wallet.wallet.walletAddress)}{' '}
                      {wallet.balance <= MIN_MINT_BALANCE_LOVELACE ? ' - Insufficient balance' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {errors.selectedWallet && (
            <p className="text-sm text-destructive">{errors.selectedWallet.message}</p>
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
