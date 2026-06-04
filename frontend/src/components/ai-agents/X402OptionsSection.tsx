import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X402Network } from '@/lib/api/generated';

export type X402OptionDraft = {
  caip2Network: string;
  asset: string;
  amount: string;
  decimals: string;
  payTo: string;
  resource: string;
};

export const emptyX402Option: X402OptionDraft = {
  caip2Network: '',
  asset: '',
  amount: '',
  decimals: '6',
  payTo: '',
  resource: '',
};

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const CAIP2_EIP155 = /^eip155:\d+$/;
const UINT = /^\d+$/;

export function validateX402Options(options: X402OptionDraft[]): string | null {
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const n = i + 1;
    if (!CAIP2_EIP155.test(option.caip2Network)) return `x402 option ${n}: select a chain`;
    if (!EVM_ADDRESS.test(option.asset)) return `x402 option ${n}: asset must be an EVM address`;
    if (!UINT.test(option.amount) || option.amount === '0') {
      return `x402 option ${n}: amount must be a positive integer in base units`;
    }
    const decimals = Number(option.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      return `x402 option ${n}: decimals must be a whole number between 0 and 255`;
    }
    if (!EVM_ADDRESS.test(option.payTo)) return `x402 option ${n}: pay-to must be an EVM address`;
    if (option.resource && !/^https?:\/\//.test(option.resource)) {
      return `x402 option ${n}: resource must be an http(s) URL`;
    }
  }
  return null;
}

export function X402OptionsSection({
  options,
  networks,
  onChange,
  error,
}: {
  options: X402OptionDraft[];
  networks: X402Network[];
  onChange: (next: X402OptionDraft[]) => void;
  error: string | null;
}) {
  const update = (index: number, patch: Partial<X402OptionDraft>) =>
    onChange(options.map((option, i) => (i === index ? { ...option, ...patch } : option)));
  const remove = (index: number) => onChange(options.filter((_, i) => i !== index));
  const add = () => onChange([...options, { ...emptyX402Option }]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">x402 payment options (optional)</h3>
          <p className="text-xs text-muted-foreground">
            Advertise EVM/x402 payment rails alongside Cardano pricing.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          className="flex items-center gap-1"
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {options.map((option, index) => (
        <div key={index} className="rounded-lg border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Option {index + 1}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-muted-foreground">Chain</label>
              <Select
                value={option.caip2Network}
                onValueChange={(value) => update(index, { caip2Network: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a chain" />
                </SelectTrigger>
                <SelectContent>
                  {networks.map((network) => (
                    <SelectItem key={network.id} value={network.caip2Id}>
                      {network.displayName}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {network.caip2Id}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-muted-foreground">Asset (token contract)</label>
              <Input
                className="font-mono"
                placeholder="0x…"
                value={option.asset}
                onChange={(e) => update(index, { asset: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Amount (base units)</label>
              <Input
                className="font-mono"
                placeholder="1000000"
                value={option.amount}
                onChange={(e) => update(index, { amount: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Decimals</label>
              <Input
                className="font-mono"
                placeholder="6"
                value={option.decimals}
                onChange={(e) => update(index, { decimals: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-muted-foreground">Pay to (recipient)</label>
              <Input
                className="font-mono"
                placeholder="0x…"
                value={option.payTo}
                onChange={(e) => update(index, { payTo: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-muted-foreground">Resource URL (optional)</label>
              <Input
                className="font-mono"
                placeholder="https://… (leave empty for none)"
                value={option.resource}
                onChange={(e) => update(index, { resource: e.target.value })}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
