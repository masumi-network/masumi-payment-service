import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';
import { RegistryEntry } from '@/lib/api/generated';

type Verification = NonNullable<RegistryEntry['verifications']>[number];

export function agentHasVerifications(verifications: RegistryEntry['verifications']): boolean {
  return (verifications ?? []).length > 0;
}

// A KERI/Veridian anchor: the AID/SAID (shortened, copyable) plus the OOBI it
// resolves from. OOBIs are untrusted fetch points — shown as plain text, not links.
function AnchorRow({ label, id, oobi }: { label: string; id: string; oobi?: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono flex items-center gap-1">
          {shortenAddress(id, 6)}
          <CopyButton value={id} />
        </span>
      </div>
      {oobi && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>OOBI</span>
          <span className="font-mono truncate max-w-[220px]" title={oobi}>
            {oobi}
          </span>
        </div>
      )}
    </div>
  );
}

export function AgentVerifications({
  verifications,
}: {
  verifications: RegistryEntry['verifications'];
}) {
  const entries: Verification[] = verifications ?? [];
  if (entries.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Verifications</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {entries.map((verification, index) => (
            <div key={index} className="space-y-1 p-2 bg-muted/40 border rounded-md">
              <div className="flex items-center justify-between pb-1">
                <Badge variant="secondary">{verification.method}</Badge>
                {verification.schemaVersion && (
                  <span className="text-xs text-muted-foreground">
                    schema v{verification.schemaVersion}
                  </span>
                )}
              </div>
              <AnchorRow
                label="Issuer AID"
                id={verification.issuer.aid}
                oobi={verification.issuer.oobi}
              />
              <AnchorRow
                label="Schema SAID"
                id={verification.schema.said}
                oobi={verification.schema.oobi}
              />
              <AnchorRow
                label="Credential SAID"
                id={verification.credential.said}
                oobi={verification.credential.oobi}
              />
              {verification.credential.registry && (
                <AnchorRow label="Registry (TEL)" id={verification.credential.registry} />
              )}
              <AnchorRow
                label="Holder AID"
                id={verification.holder.aid}
                oobi={verification.holder.oobi}
              />
              {verification.baseUrl && (
                <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
                  <span>Resolver base</span>
                  <span className="font-mono truncate max-w-[220px]" title={verification.baseUrl}>
                    {verification.baseUrl}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
