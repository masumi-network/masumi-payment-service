import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WalletLink } from '@/components/ui/wallet-link';

/**
 * Linked collection-address row for Selling/Purchasing wallets. The parent
 * guards rendering to those wallet types and owns the edit/save state.
 */
export function CollectionAddressSection({
  walletType,
  network,
  collectionAddress,
  isEditing,
  newCollectionAddress,
  onNewCollectionAddressChange,
  onSave,
  onCancelEdit,
  onStartEdit,
}: {
  walletType: 'Selling' | 'Purchasing';
  network: 'Preprod' | 'Mainnet';
  collectionAddress: string | null;
  isEditing: boolean;
  newCollectionAddress: string;
  onNewCollectionAddressChange: (value: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onStartEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 mt-2 border-t pt-4">
      <div className="text-xs text-muted-foreground">
        {walletType === 'Selling'
          ? 'Linked Revenue Collection Address'
          : 'Linked Refund Collection Address'}
      </div>
      {isEditing ? (
        <div className="flex items-center gap-2">
          <Input
            value={newCollectionAddress}
            onChange={(e) => onNewCollectionAddressChange(e.target.value)}
            placeholder="Enter collection wallet address"
            className="flex-1"
          />
          <Button size="sm" onClick={onSave} className="h-8">
            Done
          </Button>
          <Button variant="outline" size="sm" onClick={onCancelEdit} className="h-8">
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {collectionAddress ? (
            <>
              <WalletLink address={collectionAddress} network={network} shorten={15} />
              <Button variant="outline" size="sm" onClick={onStartEdit} className="h-8">
                Update
              </Button>
            </>
          ) : (
            <>
              <span className="font-mono text-sm italic text-muted-foreground">none</span>
              <Button variant="outline" size="sm" onClick={onStartEdit} className="h-8">
                Add
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
