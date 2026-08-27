import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InfoHint } from '@/components/ui/info-hint';
import { shortenAddress } from '@/lib/utils';
import {
  MAX_ADDRESSES,
  addAddresses,
  parseAddressEntries,
  type KnownAddress,
} from './address-filter';

type AddressListFieldProps = Readonly<{
  value: string;
  onChange: (value: string) => void;
  /** Addresses offered in the picker. Anything else is still typed by hand. */
  knownAddresses?: readonly KnownAddress[];
  /** Keeps the input id unique when the field appears twice on one screen. */
  idPrefix?: string;
}>;

/** Builds the address filter from the known addresses, or from pasted text. */
export function AddressListField({
  value,
  onChange,
  knownAddresses = [],
  idPrefix = 'report',
}: AddressListFieldProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const addresses = parseAddressEntries(value);
  const inputId = `${idPrefix}-address-input`;
  const unusedKnown = knownAddresses.filter((known) => !addresses.includes(known.address));

  const commitAddresses = (next: readonly string[]) => onChange(next.join('\n'));

  const addDraft = () => {
    const result = addAddresses(addresses, draft);
    if (result.addresses == null) {
      setError(
        result.invalidAddress
          ? `${shortenAddress(result.invalidAddress, 8)} is not a Cardano address.`
          : result.error,
      );
      return;
    }
    commitAddresses(result.addresses);
    setDraft('');
    setError(null);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Label htmlFor={inputId} className="leading-normal">
            Only these addresses
          </Label>
          <InfoHint label="address filter">
            <p>
              Keeps only requests where one of these addresses is the counterparty, the payout
              address, or the return address.
            </p>
            <p>
              The match is exact, so paste the address rather than typing it. Leave the list empty
              to include every counterparty.
            </p>
          </InfoHint>
        </div>
        {addresses.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              commitAddresses([]);
              setError(null);
            }}
          >
            Clear all
          </Button>
        )}
      </div>

      {addresses.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {addresses.map((address) => (
            <li
              key={address}
              className="flex items-center gap-1 rounded-full border bg-muted/30 py-1 pl-2.5 pr-1 font-mono text-[11px]"
            >
              <span title={address}>{shortenAddress(address, 10)}</span>
              <button
                type="button"
                aria-label={`Remove ${address}`}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  commitAddresses(addresses.filter((entry) => entry !== address));
                  setError(null);
                }}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {unusedKnown.length > 0 && (
        <Select
          value=""
          onValueChange={(address) => {
            const result = addAddresses(addresses, address);
            if (result.addresses == null) {
              setError(result.error);
              return;
            }
            commitAddresses(result.addresses);
            setError(null);
          }}
        >
          <SelectTrigger aria-label="Add a known address">
            <SelectValue placeholder="Add a wallet of this payment source…" />
          </SelectTrigger>
          <SelectContent>
            {unusedKnown.map((known) => (
              <SelectItem key={known.address} value={known.address}>
                <span className="truncate">{known.label}</span>
                <span className="ml-2 text-muted-foreground">{known.hint}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex gap-2">
        <Input
          id={inputId}
          className="font-mono text-xs"
          placeholder={
            unusedKnown.length > 0
              ? 'Or paste any other address'
              : 'addr_test1… or paste several at once'
          }
          value={draft}
          aria-invalid={error != null}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            addDraft();
          }}
        />
        <Button type="button" variant="outline" onClick={addDraft} disabled={!draft.trim()}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>

      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {addresses.length === 0
            ? `Optional. Up to ${MAX_ADDRESSES} addresses, matched exactly.`
            : `${addresses.length} of ${MAX_ADDRESSES} addresses. Only requests touching one of them are exported.`}
        </p>
      )}
    </div>
  );
}
