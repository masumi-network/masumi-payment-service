import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Mirrors the backend `verificationsSchema.max(10)` cap so the form rejects
// over-limit lists before they reach the API.
const MAX_VERIFICATIONS = 10;

/** Stable per-draft id so editable rows key on identity, not array index (index
 * keys misbind input state when a middle row is removed). UI-only — never sent
 * to the API. */
function newDraftId(): string {
  return crypto.randomUUID();
}

// Flat form draft for one KERI/Veridian verification claim. Mapped to/from the
// nested API shape (issuer/schema/credential/holder) by the helpers below.
export type VerificationDraft = {
  id: string;
  method: string;
  schemaVersion: string;
  issuerAid: string;
  issuerOobi: string;
  schemaSaid: string;
  schemaOobi: string;
  credentialSaid: string;
  credentialOobi: string;
  credentialRegistry: string;
  holderAid: string;
  holderOobi: string;
  baseUrl: string;
};

export const emptyVerification: Omit<VerificationDraft, 'id'> = {
  method: 'KERI-ACDC',
  schemaVersion: '1',
  issuerAid: '',
  issuerOobi: '',
  schemaSaid: '',
  schemaOobi: '',
  credentialSaid: '',
  credentialOobi: '',
  credentialRegistry: '',
  holderAid: '',
  holderOobi: '',
  baseUrl: '',
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Mirrors the backend Zod constraints (AIDs/SAIDs 1–128 chars; OOBIs http(s)
// URLs ≤500). Returns the first error message, or null when all entries are valid.
export function validateVerifications(verifications: VerificationDraft[]): string | null {
  if (verifications.length > MAX_VERIFICATIONS) {
    return `At most ${MAX_VERIFICATIONS} verifications are allowed`;
  }
  for (let i = 0; i < verifications.length; i++) {
    const v = verifications[i];
    const n = i + 1;
    const requireId = (label: string, value: string) =>
      !value.trim() || value.trim().length > 128
        ? `Verification ${n}: ${label} is required (max 128 chars)`
        : null;
    const requireOobi = (label: string, value: string) =>
      !isHttpUrl(value.trim()) || value.trim().length > 500
        ? `Verification ${n}: ${label} must be an http(s) URL`
        : null;

    if (!v.method.trim() || v.method.trim().length > 40)
      return `Verification ${n}: method is required`;
    if (v.schemaVersion.trim() && v.schemaVersion.trim().length > 16)
      return `Verification ${n}: schema version is too long (max 16 chars)`;
    const errors = [
      requireId('issuer AID', v.issuerAid),
      requireOobi('issuer OOBI', v.issuerOobi),
      requireId('schema SAID', v.schemaSaid),
      requireOobi('schema OOBI', v.schemaOobi),
      requireId('credential SAID', v.credentialSaid),
      requireOobi('credential OOBI', v.credentialOobi),
      requireId('holder AID', v.holderAid),
      requireOobi('holder OOBI', v.holderOobi),
    ];
    for (const error of errors) {
      if (error) return error;
    }
    if (v.credentialRegistry.trim() && v.credentialRegistry.trim().length > 128) {
      return `Verification ${n}: registry SAID is too long (max 128 chars)`;
    }
    if (v.baseUrl.trim() && (!isHttpUrl(v.baseUrl.trim()) || v.baseUrl.trim().length > 500)) {
      return `Verification ${n}: base URL must be an http(s) URL (max 500 chars)`;
    }
  }
  return null;
}

export type VerificationApi = {
  method: string;
  schemaVersion?: string;
  issuer: { aid: string; oobi: string };
  schema: { said: string; oobi: string };
  credential: { said: string; oobi: string; registry?: string };
  holder: { aid: string; oobi: string };
  baseUrl?: string;
};

export function verificationsToApi(verifications: VerificationDraft[]): VerificationApi[] {
  return verifications.map((v) => ({
    method: v.method.trim(),
    ...(v.schemaVersion.trim() ? { schemaVersion: v.schemaVersion.trim() } : {}),
    issuer: { aid: v.issuerAid.trim(), oobi: v.issuerOobi.trim() },
    schema: { said: v.schemaSaid.trim(), oobi: v.schemaOobi.trim() },
    credential: {
      said: v.credentialSaid.trim(),
      oobi: v.credentialOobi.trim(),
      ...(v.credentialRegistry.trim() ? { registry: v.credentialRegistry.trim() } : {}),
    },
    holder: { aid: v.holderAid.trim(), oobi: v.holderOobi.trim() },
    ...(v.baseUrl.trim() ? { baseUrl: v.baseUrl.trim() } : {}),
  }));
}

export function verificationsFromApi(
  entries: VerificationApi[] | null | undefined,
): VerificationDraft[] {
  if (!entries) return [];
  return entries.map((v) => ({
    id: newDraftId(),
    method: v.method ?? 'KERI-ACDC',
    schemaVersion: v.schemaVersion ?? '',
    issuerAid: v.issuer?.aid ?? '',
    issuerOobi: v.issuer?.oobi ?? '',
    schemaSaid: v.schema?.said ?? '',
    schemaOobi: v.schema?.oobi ?? '',
    credentialSaid: v.credential?.said ?? '',
    credentialOobi: v.credential?.oobi ?? '',
    credentialRegistry: v.credential?.registry ?? '',
    holderAid: v.holder?.aid ?? '',
    holderOobi: v.holder?.oobi ?? '',
    baseUrl: v.baseUrl ?? '',
  }));
}

function Field({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Input
        className="font-mono"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function VerificationsSection({
  verifications,
  onChange,
  error,
}: {
  verifications: VerificationDraft[];
  onChange: (next: VerificationDraft[]) => void;
  error: string | null;
}) {
  const update = (index: number, patch: Partial<VerificationDraft>) =>
    onChange(verifications.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  const remove = (index: number) => onChange(verifications.filter((_, i) => i !== index));
  const atLimit = verifications.length >= MAX_VERIFICATIONS;
  const add = () => {
    if (atLimit) return;
    onChange([...verifications, { ...emptyVerification, id: newDraftId() }]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Verifications (optional)</h3>
          <p className="text-xs text-muted-foreground">
            Advertise KERI/Veridian credential anchors so anyone can verify this agent
            independently. OOBIs are untrusted fetch points; integrity comes from the on-chain
            AIDs/SAIDs.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={atLimit}
          title={atLimit ? `At most ${MAX_VERIFICATIONS} verifications` : undefined}
          className="flex items-center gap-1"
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {verifications.map((entry, index) => (
        <div key={entry.id} className="rounded-lg border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Verification {index + 1}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field
              label="Method"
              placeholder="KERI-ACDC"
              value={entry.method}
              onChange={(value) => update(index, { method: value })}
            />
            <Field
              label="Schema version (optional)"
              placeholder="1"
              value={entry.schemaVersion}
              onChange={(value) => update(index, { schemaVersion: value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <p className="col-span-2 text-xs font-medium">Issuer</p>
            <Field
              label="AID (sad.i)"
              placeholder="E…"
              value={entry.issuerAid}
              onChange={(value) => update(index, { issuerAid: value })}
            />
            <Field
              label="OOBI"
              placeholder="https://witness…/oobi/E…"
              value={entry.issuerOobi}
              onChange={(value) => update(index, { issuerOobi: value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <p className="col-span-2 text-xs font-medium">Credential schema</p>
            <Field
              label="SAID (sad.s)"
              placeholder="E…"
              value={entry.schemaSaid}
              onChange={(value) => update(index, { schemaSaid: value })}
            />
            <Field
              label="OOBI"
              placeholder="https://schema…/oobi/E…"
              value={entry.schemaOobi}
              onChange={(value) => update(index, { schemaOobi: value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <p className="col-span-2 text-xs font-medium">Credential</p>
            <Field
              label="SAID (sad.d)"
              placeholder="E…"
              value={entry.credentialSaid}
              onChange={(value) => update(index, { credentialSaid: value })}
            />
            <Field
              label="OOBI"
              placeholder="https://cred…/oobi/E…"
              value={entry.credentialOobi}
              onChange={(value) => update(index, { credentialOobi: value })}
            />
            <Field
              label="Registry / TEL SAID (sad.ri, optional)"
              placeholder="E… (revocation registry)"
              value={entry.credentialRegistry}
              onChange={(value) => update(index, { credentialRegistry: value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <p className="col-span-2 text-xs font-medium">Holder</p>
            <Field
              label="AID (sad.a.i)"
              placeholder="E…"
              value={entry.holderAid}
              onChange={(value) => update(index, { holderAid: value })}
            />
            <Field
              label="OOBI"
              placeholder="https://keria…/oobi/E…"
              value={entry.holderOobi}
              onChange={(value) => update(index, { holderOobi: value })}
            />
          </div>

          <Field
            label="Resolver base URL (optional)"
            placeholder="https://verify… (witness/KERIA root)"
            value={entry.baseUrl}
            onChange={(value) => update(index, { baseUrl: value })}
          />
        </div>
      ))}
    </div>
  );
}
