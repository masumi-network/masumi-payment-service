import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { X402WalletKeySource } from '@/lib/x402-wallet-key';

const KEY_SOURCE_OPTIONS: Array<{ value: X402WalletKeySource; label: string }> = [
  { value: 'generate', label: 'Generate new key' },
  { value: 'import', label: 'Import existing key' },
];

/**
 * Chooses how a managed wallet gets its key: generated on the server (shown once for backup)
 * or imported from an existing 0x private key. Shared by the create-wallet dialog and the
 * x402 setup wizard.
 */
export function WalletKeySourceField({
  keySource,
  onKeySourceChange,
  privateKey,
  onPrivateKeyChange,
  error,
}: {
  keySource: X402WalletKeySource;
  onKeySourceChange: (value: X402WalletKeySource) => void;
  privateKey: string;
  onPrivateKeyChange: (value: string) => void;
  error?: string | null;
}) {
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const groupLabelId = useId();
  const keyInputId = useId();
  const hintId = useId();
  const errorId = useId();

  return (
    <div className="space-y-2">
      <p id={groupLabelId} className="text-sm font-medium">
        Key
      </p>
      <div
        role="radiogroup"
        aria-labelledby={groupLabelId}
        className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/40 p-1"
      >
        {KEY_SOURCE_OPTIONS.map((option) => {
          const isSelected = keySource === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onKeySourceChange(option.value)}
              className={cn(
                'rounded-sm px-3 py-1.5 text-sm font-medium transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {keySource === 'generate' ? (
        <p className="text-xs leading-snug text-muted-foreground">
          The server creates a new key. You see it once, right after creation, so you can back it
          up.
        </p>
      ) : (
        <div className="space-y-1.5 pt-1">
          <Label htmlFor={keyInputId} className="text-sm font-medium">
            Private key
          </Label>
          <div className="relative">
            <Textarea
              id={keyInputId}
              placeholder="0x followed by 64 hex characters"
              className="min-h-[76px] resize-none pe-10 font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
              value={privateKey}
              aria-invalid={!!error}
              aria-describedby={error ? errorId : hintId}
              onChange={(event) => onPrivateKeyChange(event.target.value)}
              style={
                isKeyVisible
                  ? undefined
                  : ({ WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties)
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute end-1.5 top-1.5 size-7 text-muted-foreground"
              onClick={() => setIsKeyVisible((value) => !value)}
              aria-label={isKeyVisible ? 'Hide private key' : 'Show private key'}
              aria-pressed={isKeyVisible}
            >
              {isKeyVisible ? (
                <EyeOff className="size-3.5" aria-hidden />
              ) : (
                <Eye className="size-3.5" aria-hidden />
              )}
            </Button>
          </div>
          {error ? (
            <p id={errorId} className="text-xs text-destructive">
              {error}
            </p>
          ) : (
            <p id={hintId} className="text-xs text-muted-foreground">
              The key is stored encrypted and is never shown again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
