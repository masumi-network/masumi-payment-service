/**
 * Connect a Hydra node.
 *
 * One form for the whole thing. A Hydra node here is a Hydra Host: a
 * reverse-proxied control plane that runs a hydra-node process per head and
 * generates that node's keys itself. Connecting it needs its URL and its two
 * tokens — nothing per-head, because heads are provisioned through this node
 * rather than configured by hand.
 *
 * The two tokens are separate on purpose. The admin key provisions and
 * reconfigures nodes; the user key is what the service uses at runtime to
 * reach the proxied node API. A node connected with only a user key can run
 * existing heads but cannot open new ones.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { HydraDetailSection } from '@/components/hydra/HydraDetailSection';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppContext } from '@/lib/contexts/AppContext';
import { connectHydraHost, updateHydraHost, type HydraHost } from '@/lib/hooks/useHydraHosts';

type Network = 'Preprod' | 'Mainnet';

type ConnectHydraNodeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
  /** Set to edit an already-connected node instead of adding one. */
  host?: HydraHost | null;
};

/** The Host refuses anything shorter; failing here is clearer than a 400. */
const MIN_TOKEN_LENGTH = 32;

function isCardanoNetwork(value: string | undefined): value is Network {
  return value === 'Preprod' || value === 'Mainnet';
}

/**
 * The peer host is dialled directly by the counterparty's node, so it is a bare
 * hostname or IP — not a URL. Catching that here avoids a head that only fails
 * much later, when the two nodes cannot form a cluster.
 */
function peerHostProblem(value: string): string | null {
  if (value.length === 0) {
    return 'A public peer host is required.';
  }
  if (/^[a-z]+:\/\//i.test(value) || value.includes('/') || value.includes(':')) {
    return 'Use a bare hostname or IP, with no scheme, port or path.';
  }
  return null;
}

function baseUrlProblem(value: string): string | null {
  if (value.length === 0) {
    return 'A control-plane URL is required.';
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'The URL must be http or https.';
    }
  } catch {
    return 'That is not a valid URL.';
  }
  return null;
}

export function ConnectHydraNodeDialog({
  open,
  onOpenChange,
  onConnected,
  host,
}: ConnectHydraNodeDialogProps) {
  const { apiClient, network: contextNetwork } = useAppContext();
  const isEditing = Boolean(host);

  const [name, setName] = useState('');
  const [network, setNetwork] = useState<Network>('Preprod');
  const [baseUrl, setBaseUrl] = useState('');
  const [publicPeerHost, setPublicPeerHost] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [userToken, setUserToken] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(host?.name ?? '');
    setNetwork(host?.network ?? (isCardanoNetwork(contextNetwork) ? contextNetwork : 'Preprod'));
    setBaseUrl(host?.baseUrl ?? '');
    setPublicPeerHost(host?.publicPeerHost ?? '');
    // Never prefilled: the API does not return tokens, and an empty field on an
    // edit means "leave the stored one alone".
    setAdminToken('');
    setUserToken('');
  }, [open, host, contextNetwork]);

  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const trimmedPeerHost = publicPeerHost.trim();

  function validate(): string | null {
    if (name.trim().length === 0) {
      return 'A name is required.';
    }
    if (!isEditing) {
      const urlProblem = baseUrlProblem(trimmedBaseUrl);
      if (urlProblem) return urlProblem;
      // Only when overridden: left blank it is taken from the URL above, which
      // is right unless peers reach the Host by a different name.
      if (trimmedPeerHost.length > 0) {
        const peerProblem = peerHostProblem(trimmedPeerHost);
        if (peerProblem) return peerProblem;
      }
      if (adminToken.trim().length < MIN_TOKEN_LENGTH) {
        return `The admin key must be at least ${MIN_TOKEN_LENGTH} characters.`;
      }
    }
    if (adminToken.length > 0 && adminToken.trim().length < MIN_TOKEN_LENGTH) {
      return `The admin key must be at least ${MIN_TOKEN_LENGTH} characters.`;
    }
    if (userToken.trim().length > 0 && userToken.trim().length < MIN_TOKEN_LENGTH) {
      return `The user key must be at least ${MIN_TOKEN_LENGTH} characters.`;
    }
    if (isEditing && userToken.length > 0 && userToken.trim().length < MIN_TOKEN_LENGTH) {
      return `The user key must be at least ${MIN_TOKEN_LENGTH} characters.`;
    }
    if (adminToken.trim().length > 0 && adminToken.trim() === userToken.trim()) {
      return 'The admin and user keys must differ; the two tiers exist to separate fleet management from node operation.';
    }
    return null;
  }

  async function handleSubmit() {
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }

    setIsSubmitting(true);
    try {
      if (host) {
        await updateHydraHost(apiClient, {
          id: host.id,
          name: name.trim(),
          ...(userToken.trim().length > 0 ? { userToken: userToken.trim() } : {}),
          ...(adminToken.trim().length > 0 ? { adminToken: adminToken.trim() } : {}),
        });
        toast.success(`Updated ${name.trim()}`);
      } else {
        await connectHydraHost(apiClient, {
          name: name.trim(),
          network,
          baseUrl: trimmedBaseUrl,
          ...(trimmedPeerHost.length > 0 ? { publicPeerHost: trimmedPeerHost } : {}),
          ...(userToken.trim().length > 0 ? { userToken: userToken.trim() } : {}),
          adminToken: adminToken.trim(),
        });
        toast.success(`Connected ${name.trim()}`);
      }
      onConnected();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to connect the node');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Hydra node' : 'Connect a Hydra node'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Change the label or rotate a key. Leave a key blank to keep the stored one.'
              : 'Point the service at a Hydra node. It provisions a hydra-node per head and generates that node’s keys itself, so nothing per-head is configured here.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="hydra-node-name">Name</Label>
            <Input
              id="hydra-node-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="hydra-eu-1"
              autoComplete="off"
            />
          </div>

          {!isEditing && (
            <>
              <div className="space-y-2">
                <Label htmlFor="hydra-node-network">Network</Label>
                <Select value={network} onValueChange={(value) => setNetwork(value as Network)}>
                  <SelectTrigger id="hydra-node-network">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Preprod">Preprod</SelectItem>
                    <SelectItem value="Mainnet">Mainnet</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="hydra-node-url">Control-plane URL</Label>
                <Input
                  id="hydra-node-url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://hydra1.example.com"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Where this service reaches the node. TLS terminates in front of it.
                </p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="hydra-node-admin-key">
              Admin key{isEditing ? ' (leave blank to keep)' : ''}
            </Label>
            <Input
              id="hydra-node-admin-key"
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder={isEditing ? 'Unchanged' : 'At least 32 characters'}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Opens heads on this node and runs them. Stored encrypted and never shown again.
            </p>
          </div>

          {/* The two values that were required and almost never differ from their
              defaults: the admin key satisfies runtime calls on its own, and peers
              reach the Host at the same hostname this service does. Asking for
              both up front made a two-field form into a four-field one. */}
          <HydraDetailSection title="Advanced" summary="Peer hostname, separate runtime key">
            <div className="space-y-4">
              {!isEditing && (
                <div className="space-y-2">
                  <Label htmlFor="hydra-node-peer-host">Public peer host</Label>
                  <Input
                    id="hydra-node-peer-host"
                    value={publicPeerHost}
                    onChange={(event) => setPublicPeerHost(event.target.value)}
                    placeholder="taken from the URL above"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Hostname the counterparty’s node dials for each head’s peer port. Set this only
                    when peers reach the node by a different name than this service does. A bare
                    hostname or IP, no scheme or port.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="hydra-node-user-key">
                  User key{isEditing ? ' (leave blank to keep)' : ''}
                </Label>
                <Input
                  id="hydra-node-user-key"
                  type="password"
                  value={userToken}
                  onChange={(event) => setUserToken(event.target.value)}
                  placeholder="the admin key is used when this is blank"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  A lower-privilege key for day-to-day node access. The admin key already covers it,
                  so set this only if you would rather not use the admin key at runtime.
                </p>
              </div>
            </div>
          </HydraDetailSection>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEditing ? 'Save' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
