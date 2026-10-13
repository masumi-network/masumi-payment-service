import { CopyButton } from '@/components/ui/copy-button';
import { WalletLink } from '@/components/ui/wallet-link';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 px-4 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

/** Address, note and key of a wallet, as one compact card. */
export function WalletIdentitySection({
  address,
  note,
  vkey,
  network,
}: {
  address: string;
  note: string | null;
  vkey: string;
  network: 'Preprod' | 'Mainnet';
}) {
  return (
    <div className="divide-y rounded-lg border">
      <Row label="Address">
        <WalletLink address={address} network={network} shorten={18} />
      </Row>
      {note && (
        <Row label="Note">
          <span className="wrap-break-word">{note}</span>
        </Row>
      )}
      <Row label="Key hash">
        <div className="flex items-center gap-1">
          <span className="truncate font-mono text-xs">{vkey}</span>
          <CopyButton value={vkey} />
        </div>
      </Row>
    </div>
  );
}
