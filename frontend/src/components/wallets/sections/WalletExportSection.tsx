import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

/**
 * Mnemonic display shown after a successful wallet export. Rendered only when
 * `exportedMnemonic` is set; the Export button itself stays in the parent's
 * action row.
 */
export function WalletExportSection({
  exportedMnemonic,
  onClose,
  onCopyMnemonic,
  onDownload,
}: {
  exportedMnemonic: string;
  onClose: () => void;
  onCopyMnemonic: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="bg-muted rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium ">Mnemonic</div>
        <div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <textarea
        className="w-full font-mono text-sm bg-background rounded p-2 mb-2"
        value={exportedMnemonic}
        readOnly
        rows={3}
        style={{ resize: 'none' }}
      />
      <div className="flex gap-2">
        <Button onClick={onCopyMnemonic} size="sm">
          Copy Mnemonic
        </Button>
        <Button onClick={onDownload} size="sm" variant="outline">
          Download JSON
        </Button>
      </div>
    </div>
  );
}
