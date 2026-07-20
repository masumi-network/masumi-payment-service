import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Wifi } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useWallets } from '@/lib/queries/useWallets';
import { cn, shortenAddress } from '@/lib/utils';
import {
  checkHydraNode,
  createHydraHead,
  createHydraLocalParticipant,
  createHydraRelation,
  createHydraRemoteParticipant,
  ensureHydraWalletBaseForHotWallet,
  type HydraNodeCheckResult,
  type HydraParticipant,
  type HydraRelation,
  type HydraRemoteParticipant,
  type HydraWalletBase,
  useHydraLocalParticipants,
  useHydraRelations,
  useHydraRemoteParticipants,
  useHydraWalletBases,
} from '@/lib/hooks/useHydraHeads';

type Network = 'Preprod' | 'Mainnet';

type AddHydraHeadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
};

type RelationMode = 'existing' | 'new';
type ParticipantMode = 'existing' | 'new';
type RemoteWalletOption = {
  value: string;
  kind: 'wallet-base' | 'hot-wallet';
  walletBaseId?: string;
  hotWalletId?: string;
  paymentSourceId: string;
  walletVkey: string;
  walletAddress: string;
  type: string;
  note: string | null;
};

const DEFAULT_CONTESTATION_PERIOD = 86400;

function isCardanoNetwork(value: string | undefined): value is Network {
  return value === 'Preprod' || value === 'Mainnet';
}

function getWalletLabel(
  wallet?: {
    note?: string | null;
    walletAddress?: string;
    walletVkey?: string;
    type?: string;
  } | null,
) {
  if (!wallet) return 'Unknown wallet';
  const name = wallet.note?.trim() || wallet.type || 'Wallet';
  const identifier = wallet.walletAddress || wallet.walletVkey || '';
  return identifier ? `${name} · ${shortenAddress(identifier, 8)}` : name;
}

function getParticipantLabel(
  participant: HydraParticipant | HydraRemoteParticipant,
  wallet?: {
    note?: string | null;
    walletAddress?: string;
    walletVkey?: string;
    type?: string;
  } | null,
) {
  return `${getWalletLabel(wallet)} · ${participant.nodeHttpUrl}`;
}

function getRelationLabel(relation: HydraRelation) {
  const local = getWalletLabel(relation.LocalHotWallet);
  const remote = getWalletLabel(relation.RemoteWallet);
  const headCount = relation._count?.Heads ?? 0;
  return `${local} → ${remote} · ${headCount} head${headCount === 1 ? '' : 's'}`;
}

function getWalletBaseKey(wallet: {
  paymentSourceId: string;
  walletVkey: string;
  walletAddress: string;
  type: string;
}) {
  return `${wallet.paymentSourceId}:${wallet.walletVkey}:${wallet.walletAddress}:${wallet.type}`;
}

function getWalletTypeForHotWallet(type: string) {
  return type === 'Purchasing' ? 'Buyer' : 'Seller';
}

function getHotWalletBaseKey(wallet: {
  paymentSourceId: string;
  walletVkey: string;
  walletAddress: string;
  type: string;
}) {
  return getWalletBaseKey({
    paymentSourceId: wallet.paymentSourceId,
    walletVkey: wallet.walletVkey,
    walletAddress: wallet.walletAddress,
    type: getWalletTypeForHotWallet(wallet.type),
  });
}

function NodeCheckResult({ result }: { result: HydraNodeCheckResult | null }) {
  if (!result) return null;

  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 text-xs',
        result.reachable
          ? 'border-green-200 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200'
          : 'border-destructive/30 bg-destructive/5 text-destructive',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.reachable ? 'success' : 'destructive'}>
          {result.reachable ? 'Reachable' : 'Unreachable'}
        </Badge>
        <span>HTTP {result.httpStatus ?? '-'}</span>
        <span>Protocol {result.protocolParametersOk ? 'ok' : 'failed'}</span>
        <span>WebSocket {result.websocketReachable ? 'ok' : 'unchecked'}</span>
        {result.status && <span>Status {result.status}</span>}
      </div>
      {result.error && <p className="mt-1 break-words">{result.error}</p>}
    </div>
  );
}

function InlineLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function AddHydraHeadDialog({ open, onOpenChange, onCreated }: AddHydraHeadDialogProps) {
  const { apiClient, selectedPaymentSource } = useAppContext();
  const { wallets: localWallets, isLoading: isLoadingLocalWallets } = useWallets();
  const network = isCardanoNetwork(selectedPaymentSource?.network)
    ? selectedPaymentSource.network
    : undefined;

  const {
    relations,
    isLoading: isLoadingRelations,
    refetch: refetchRelations,
  } = useHydraRelations(network);
  const { wallets: remoteWallets, isLoading: isLoadingRemoteWallets } =
    useHydraWalletBases(network);

  const [relationMode, setRelationMode] = useState<RelationMode>('existing');
  const [relationId, setRelationId] = useState('');
  const [newRelationLocalWalletId, setNewRelationLocalWalletId] = useState('');
  const [newRelationRemoteWalletOption, setNewRelationRemoteWalletOption] = useState('');
  const [localParticipantMode, setLocalParticipantMode] = useState<ParticipantMode>('existing');
  const [localParticipantId, setLocalParticipantId] = useState('');
  const [localNodeUrl, setLocalNodeUrl] = useState('');
  const [localNodeHttpUrl, setLocalNodeHttpUrl] = useState('');
  const [hydraSK, setHydraSK] = useState('');
  const [selectedRemoteParticipantIds, setSelectedRemoteParticipantIds] = useState<string[]>([]);
  const [isCreatingRemoteParticipant, setIsCreatingRemoteParticipant] = useState(false);
  const [remoteNodeUrl, setRemoteNodeUrl] = useState('');
  const [remoteNodeHttpUrl, setRemoteNodeHttpUrl] = useState('');
  const [hydraVK, setHydraVK] = useState('');
  const [contestationPeriod, setContestationPeriod] = useState(
    DEFAULT_CONTESTATION_PERIOD.toString(),
  );
  const [localCheck, setLocalCheck] = useState<HydraNodeCheckResult | null>(null);
  const [remoteCheck, setRemoteCheck] = useState<HydraNodeCheckResult | null>(null);
  const [checkingNode, setCheckingNode] = useState<'local' | 'remote' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedRelation = useMemo(
    () => relations.find((relation) => relation.id === relationId) ?? null,
    [relationId, relations],
  );

  const effectiveLocalWalletId =
    relationMode === 'existing' ? selectedRelation?.localHotWalletId : newRelationLocalWalletId;

  const controlledWalletBaseKeys = useMemo(
    () => new Set(localWallets.map((wallet) => getHotWalletBaseKey(wallet))),
    [localWallets],
  );

  const remoteWalletOptions = useMemo<RemoteWalletOption[]>(() => {
    const existingKeys = new Set(remoteWallets.map((wallet) => getWalletBaseKey(wallet)));
    const walletBaseOptions = remoteWallets.map((wallet) => ({
      value: `wallet-base:${wallet.id}`,
      kind: 'wallet-base' as const,
      walletBaseId: wallet.id,
      paymentSourceId: wallet.paymentSourceId,
      walletVkey: wallet.walletVkey,
      walletAddress: wallet.walletAddress,
      type: wallet.type,
      note: wallet.note,
    }));
    const hotWalletOptions = localWallets
      .map((wallet) => ({
        value: `hot-wallet:${wallet.id}`,
        kind: 'hot-wallet' as const,
        hotWalletId: wallet.id,
        paymentSourceId: wallet.paymentSourceId,
        walletVkey: wallet.walletVkey,
        walletAddress: wallet.walletAddress,
        type: getWalletTypeForHotWallet(wallet.type),
        note: wallet.note,
      }))
      .filter((wallet) => !existingKeys.has(getWalletBaseKey(wallet)));

    return [...walletBaseOptions, ...hotWalletOptions];
  }, [localWallets, remoteWallets]);

  const selectedRemoteWalletOption = useMemo(
    () =>
      remoteWalletOptions.find((option) => option.value === newRelationRemoteWalletOption) ?? null,
    [newRelationRemoteWalletOption, remoteWalletOptions],
  );

  const selectedRemoteWalletBaseId =
    selectedRemoteWalletOption?.kind === 'wallet-base'
      ? selectedRemoteWalletOption.walletBaseId
      : undefined;

  const effectiveRemoteWalletId =
    relationMode === 'existing' ? selectedRelation?.remoteWalletId : selectedRemoteWalletBaseId;

  const {
    participants: localParticipants,
    isLoading: isLoadingLocalParticipants,
    refetch: refetchLocalParticipants,
  } = useHydraLocalParticipants(effectiveLocalWalletId || undefined);
  const {
    participants: remoteParticipants,
    isLoading: isLoadingRemoteParticipants,
    refetch: refetchRemoteParticipants,
  } = useHydraRemoteParticipants(effectiveRemoteWalletId || undefined);

  const effectiveLocalWallet = useMemo(
    () => localWallets.find((wallet) => wallet.id === effectiveLocalWalletId),
    [effectiveLocalWalletId, localWallets],
  );

  const effectiveRemoteWallet = useMemo(
    () =>
      relationMode === 'existing'
        ? remoteWallets.find((wallet) => wallet.id === effectiveRemoteWalletId)
        : selectedRemoteWalletOption,
    [effectiveRemoteWalletId, relationMode, remoteWallets, selectedRemoteWalletOption],
  );
  const isSelectedRemoteWalletExternal = useMemo(() => {
    if (!effectiveRemoteWallet) {
      return false;
    }
    return !controlledWalletBaseKeys.has(getWalletBaseKey(effectiveRemoteWallet));
  }, [controlledWalletBaseKeys, effectiveRemoteWallet]);
  const availableLocalParticipants = useMemo(
    () => (effectiveLocalWalletId ? localParticipants : []),
    [effectiveLocalWalletId, localParticipants],
  );
  const availableRemoteParticipants = useMemo(
    () => (effectiveRemoteWalletId ? remoteParticipants : []),
    [effectiveRemoteWalletId, remoteParticipants],
  );

  useEffect(() => {
    if (!open) return;
    if (isLoadingRelations) return;
    if (relations.length === 0) {
      setRelationMode('new');
      return;
    }
    setRelationId((currentId) => currentId || relations[0]?.id || '');
  }, [isLoadingRelations, open, relations]);

  useEffect(() => {
    if (!open || relationMode !== 'new') return;
    if (isLoadingLocalWallets || isLoadingRemoteWallets) return;
    setNewRelationLocalWalletId((currentId) => currentId || localWallets[0]?.id || '');
    setNewRelationRemoteWalletOption(
      (currentOption) => currentOption || remoteWalletOptions[0]?.value || '',
    );
  }, [
    isLoadingLocalWallets,
    isLoadingRemoteWallets,
    localWallets,
    open,
    relationMode,
    remoteWalletOptions,
  ]);

  useEffect(() => {
    setLocalParticipantId('');
    setSelectedRemoteParticipantIds([]);
  }, [effectiveLocalWalletId, effectiveRemoteWalletId]);

  useEffect(() => {
    if (isSelectedRemoteWalletExternal) {
      setIsCreatingRemoteParticipant(false);
    }
  }, [isSelectedRemoteWalletExternal]);

  useEffect(() => {
    if (localParticipantMode === 'existing' && availableLocalParticipants.length > 0) {
      setLocalParticipantId((currentId) => currentId || availableLocalParticipants[0]?.id || '');
    }
  }, [availableLocalParticipants, localParticipantMode]);

  const resetForm = () => {
    setRelationMode(relations.length > 0 ? 'existing' : 'new');
    setRelationId(relations[0]?.id ?? '');
    setNewRelationLocalWalletId('');
    setNewRelationRemoteWalletOption('');
    setLocalParticipantMode('existing');
    setLocalParticipantId('');
    setLocalNodeUrl('');
    setLocalNodeHttpUrl('');
    setHydraSK('');
    setSelectedRemoteParticipantIds([]);
    setIsCreatingRemoteParticipant(false);
    setRemoteNodeUrl('');
    setRemoteNodeHttpUrl('');
    setHydraVK('');
    setContestationPeriod(DEFAULT_CONTESTATION_PERIOD.toString());
    setLocalCheck(null);
    setRemoteCheck(null);
  };

  const toggleRemoteParticipant = (participantId: string, checked: boolean) => {
    setSelectedRemoteParticipantIds((currentIds) =>
      checked
        ? [...currentIds, participantId]
        : currentIds.filter((currentId) => currentId !== participantId),
    );
  };

  const runNodeCheck = async (target: 'local' | 'remote') => {
    const nodeHttpUrl = target === 'local' ? localNodeHttpUrl : remoteNodeHttpUrl;
    const nodeUrl = target === 'local' ? localNodeUrl : remoteNodeUrl;

    if (!nodeHttpUrl.trim()) {
      toast.error('Enter the Hydra node HTTP URL first');
      return;
    }

    setCheckingNode(target);
    try {
      const result = await checkHydraNode(apiClient, {
        nodeHttpUrl: nodeHttpUrl.trim(),
        nodeUrl: nodeUrl.trim() || undefined,
        timeoutMs: 5000,
      });
      if (target === 'local') {
        setLocalCheck(result);
      } else {
        setRemoteCheck(result);
      }
    } finally {
      setCheckingNode(null);
    }
  };

  const canSubmit =
    !isLoadingLocalWallets &&
    !isLoadingRemoteWallets &&
    !isLoadingRelations &&
    !isLoadingLocalParticipants &&
    !isLoadingRemoteParticipants &&
    Boolean(network) &&
    Boolean(
      relationMode === 'existing'
        ? relationId
        : newRelationLocalWalletId && newRelationRemoteWalletOption,
    ) &&
    Boolean(
      localParticipantMode === 'existing'
        ? localParticipantId
        : effectiveLocalWalletId &&
            localNodeUrl.trim() &&
            localNodeHttpUrl.trim() &&
            hydraSK.trim(),
    ) &&
    (selectedRemoteParticipantIds.length > 0 ||
      (!isSelectedRemoteWalletExternal &&
        isCreatingRemoteParticipant &&
        Boolean(
          (relationMode === 'existing' ? effectiveRemoteWalletId : newRelationRemoteWalletOption) &&
          remoteNodeUrl.trim() &&
          remoteNodeHttpUrl.trim() &&
          hydraVK.trim(),
        ))) &&
    Number.parseInt(contestationPeriod, 10) > 0;

  const resolveRemoteWalletBaseId = async () => {
    if (relationMode === 'existing') {
      return selectedRelation?.remoteWalletId || '';
    }

    if (!selectedRemoteWalletOption) {
      throw new Error('Select a remote wallet');
    }

    if (selectedRemoteWalletOption.kind === 'wallet-base') {
      return selectedRemoteWalletOption.walletBaseId || '';
    }

    const walletBase = await ensureHydraWalletBaseForHotWallet(apiClient, {
      hotWalletId: selectedRemoteWalletOption.hotWalletId || '',
    });
    return walletBase.id;
  };

  const submit = async () => {
    if (!network) {
      toast.error('Select a Cardano payment source first');
      return;
    }
    if (!canSubmit) {
      toast.error('Complete the required Hydra setup fields');
      return;
    }

    setIsSubmitting(true);
    try {
      const resolvedRemoteWalletId =
        relationMode === 'existing'
          ? selectedRelation?.remoteWalletId || ''
          : await resolveRemoteWalletBaseId();

      const resolvedRelationId =
        relationMode === 'existing'
          ? relationId
          : (
              await createHydraRelation(apiClient, {
                network,
                localHotWalletId: newRelationLocalWalletId,
                remoteWalletId: resolvedRemoteWalletId,
              })
            ).id;

      const resolvedLocalParticipantId =
        localParticipantMode === 'existing'
          ? localParticipantId
          : (
              await createHydraLocalParticipant(apiClient, {
                walletId: effectiveLocalWalletId || '',
                nodeUrl: localNodeUrl.trim(),
                nodeHttpUrl: localNodeHttpUrl.trim(),
                hydraSK: hydraSK.trim(),
              })
            ).id;

      const resolvedRemoteParticipantIds = [...selectedRemoteParticipantIds];
      if (isCreatingRemoteParticipant) {
        const remoteParticipant = await createHydraRemoteParticipant(apiClient, {
          walletId: resolvedRemoteWalletId,
          nodeUrl: remoteNodeUrl.trim(),
          nodeHttpUrl: remoteNodeHttpUrl.trim(),
          hydraVK: hydraVK.trim(),
        });
        resolvedRemoteParticipantIds.push(remoteParticipant.id);
      }

      await createHydraHead(apiClient, {
        hydraRelationId: resolvedRelationId,
        localParticipantId: resolvedLocalParticipantId,
        remoteParticipantIds: resolvedRemoteParticipantIds,
        contestationPeriod: Number.parseInt(contestationPeriod, 10),
      });

      toast.success('Hydra head created');
      await Promise.all([
        refetchRelations(),
        refetchLocalParticipants(),
        refetchRemoteParticipants(),
      ]);
      onCreated();
      resetForm();
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const localParticipantRequiresCreate =
    localParticipantMode === 'new' ||
    (!isLoadingLocalParticipants && availableLocalParticipants.length === 0);
  const remoteParticipantRequiresCreate =
    !isSelectedRemoteWalletExternal &&
    (isCreatingRemoteParticipant ||
      (!isLoadingRemoteParticipants && availableRemoteParticipants.length === 0));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Add Hydra head</DialogTitle>
          <DialogDescription>
            Configure the wallet pair, participants, and node reachability for the selected payment
            source.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-3">
            <div className="rounded-lg border p-4">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Local</h2>
                  <p className="text-xs text-muted-foreground">
                    Own hot wallet and the Hydra node controlled by this service.
                  </p>
                </div>
                <div className="flex rounded-md border p-1">
                  <Button
                    type="button"
                    variant={relationMode === 'existing' ? 'secondary' : 'ghost'}
                    size="sm"
                    disabled={isLoadingRelations}
                    onClick={() => {
                      if (relations.length === 0) {
                        toast.info('No existing Hydra relations yet');
                        setRelationMode('new');
                        return;
                      }
                      setRelationMode('existing');
                    }}
                  >
                    Existing
                  </Button>
                  <Button
                    type="button"
                    variant={relationMode === 'new' ? 'secondary' : 'ghost'}
                    size="sm"
                    disabled={isLoadingLocalWallets || isLoadingRemoteWallets}
                    onClick={() => setRelationMode('new')}
                  >
                    New
                  </Button>
                </div>
              </div>

              <div className="grid gap-3">
                {isLoadingRelations && relationMode === 'existing' ? (
                  <InlineLoading label="Loading Hydra relations..." />
                ) : relationMode === 'existing' ? (
                  <div className="grid gap-2">
                    <Label>Hydra relation</Label>
                    <Select value={relationId} onValueChange={setRelationId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select relation" />
                      </SelectTrigger>
                      <SelectContent>
                        {relations.map((relation) => (
                          <SelectItem key={relation.id} value={relation.id}>
                            {getRelationLabel(relation)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : isLoadingLocalWallets ? (
                  <InlineLoading label="Loading own wallets..." />
                ) : (
                  <div className="grid gap-2">
                    <Label>Own hot wallet</Label>
                    <Select
                      value={newRelationLocalWalletId}
                      onValueChange={setNewRelationLocalWalletId}
                      disabled={isLoadingLocalWallets || localWallets.length === 0}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select local wallet" />
                      </SelectTrigger>
                      <SelectContent>
                        {localWallets.map((wallet) => (
                          <SelectItem key={wallet.id} value={wallet.id}>
                            {getWalletLabel(wallet)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <div>
                    <h3 className="text-sm font-medium">Local participant</h3>
                    <p className="text-xs text-muted-foreground">Saved config or node/key entry.</p>
                  </div>
                  <div className="flex rounded-md border p-1">
                    <Button
                      type="button"
                      variant={!localParticipantRequiresCreate ? 'secondary' : 'ghost'}
                      size="sm"
                      disabled={isLoadingLocalParticipants}
                      onClick={() => {
                        if (availableLocalParticipants.length === 0) {
                          toast.info('No saved local participant for this wallet');
                          setLocalParticipantMode('new');
                          return;
                        }
                        setLocalParticipantMode('existing');
                      }}
                    >
                      Existing
                    </Button>
                    <Button
                      type="button"
                      variant={localParticipantRequiresCreate ? 'secondary' : 'ghost'}
                      size="sm"
                      disabled={isLoadingLocalParticipants}
                      onClick={() => setLocalParticipantMode('new')}
                    >
                      New
                    </Button>
                  </div>
                </div>

                {isLoadingLocalParticipants ? (
                  <InlineLoading label="Loading local participant configs..." />
                ) : !localParticipantRequiresCreate ? (
                  <div className="grid gap-2">
                    <Label>Unassigned local participant</Label>
                    <Select value={localParticipantId} onValueChange={setLocalParticipantId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select local participant" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableLocalParticipants.map((participant) => (
                          <SelectItem key={participant.id} value={participant.id}>
                            {getParticipantLabel(participant, effectiveLocalWallet)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="grid gap-3">
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      <div className="grid gap-2">
                        <Label>Node WebSocket URL</Label>
                        <Input
                          value={localNodeUrl}
                          onChange={(event) => setLocalNodeUrl(event.target.value)}
                          placeholder="ws://127.0.0.1:4001"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>Node HTTP URL</Label>
                        <Input
                          value={localNodeHttpUrl}
                          onChange={(event) => setLocalNodeHttpUrl(event.target.value)}
                          placeholder="http://127.0.0.1:4001"
                        />
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label>Hydra signing key</Label>
                      <Textarea
                        value={hydraSK}
                        onChange={(event) => setHydraSK(event.target.value)}
                        placeholder="Paste the local Hydra signing key"
                        className="min-h-24 font-mono text-xs"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void runNodeCheck('local')}
                        disabled={checkingNode === 'local'}
                      >
                        {checkingNode === 'local' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Wifi className="h-4 w-4" />
                        )}
                        Check local node
                      </Button>
                      <NodeCheckResult result={localCheck} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <div className="mb-4">
                <h2 className="text-sm font-medium">Remote</h2>
                <p className="text-xs text-muted-foreground">
                  Counterparty wallet. Node API fields appear only when this is also one of our hot
                  wallets.
                </p>
              </div>

              <div className="grid gap-3">
                {relationMode === 'existing' && (isLoadingRelations || isLoadingRemoteWallets) ? (
                  <InlineLoading label="Loading remote wallet..." />
                ) : relationMode === 'existing' ? null : isLoadingRemoteWallets ||
                  isLoadingLocalWallets ? (
                  <InlineLoading label="Loading remote wallet options..." />
                ) : (
                  <div className="grid gap-2">
                    <Label>Remote wallet</Label>
                    <Select
                      value={newRelationRemoteWalletOption}
                      onValueChange={setNewRelationRemoteWalletOption}
                      disabled={
                        isLoadingRemoteWallets ||
                        isLoadingLocalWallets ||
                        remoteWalletOptions.length === 0
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select remote wallet" />
                      </SelectTrigger>
                      <SelectContent>
                        {remoteWalletOptions.map((wallet) => (
                          <SelectItem key={wallet.value} value={wallet.value}>
                            {getWalletLabel(wallet)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {isSelectedRemoteWalletExternal && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                    External wallet selected. Remote node URL/key entry is disabled; select a saved
                    remote participant record.
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <div>
                    <h3 className="text-sm font-medium">Remote participant</h3>
                    <p className="text-xs text-muted-foreground">
                      Existing metadata or optional node API when we control the wallet.
                    </p>
                  </div>
                  <div className="flex rounded-md border p-1">
                    <Button
                      type="button"
                      variant={!remoteParticipantRequiresCreate ? 'secondary' : 'ghost'}
                      size="sm"
                      disabled={isLoadingRemoteParticipants}
                      onClick={() => {
                        if (availableRemoteParticipants.length === 0) {
                          toast.info(
                            isSelectedRemoteWalletExternal
                              ? 'External wallets need a saved remote participant'
                              : 'No saved remote participant for this wallet',
                          );
                          setIsCreatingRemoteParticipant(!isSelectedRemoteWalletExternal);
                          return;
                        }
                        setIsCreatingRemoteParticipant(false);
                      }}
                    >
                      Existing
                    </Button>
                    <Button
                      type="button"
                      variant={remoteParticipantRequiresCreate ? 'secondary' : 'ghost'}
                      size="sm"
                      disabled={isSelectedRemoteWalletExternal || isLoadingRemoteParticipants}
                      onClick={() => {
                        if (isSelectedRemoteWalletExternal) {
                          toast.info('New remote participants are disabled for external wallets');
                          return;
                        }
                        setIsCreatingRemoteParticipant(true);
                      }}
                    >
                      New
                    </Button>
                  </div>
                </div>

                {isLoadingRemoteParticipants ? (
                  <InlineLoading label="Loading remote participant configs..." />
                ) : availableRemoteParticipants.length > 0 && !remoteParticipantRequiresCreate ? (
                  <div className="grid gap-2">
                    {availableRemoteParticipants.map((participant) => (
                      <label
                        key={participant.id}
                        className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
                      >
                        <Checkbox
                          checked={selectedRemoteParticipantIds.includes(participant.id)}
                          onCheckedChange={(checked) =>
                            toggleRemoteParticipant(participant.id, checked === true)
                          }
                        />
                        <span className="min-w-0 break-words">
                          {getParticipantLabel(participant, effectiveRemoteWallet)}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {remoteParticipantRequiresCreate && (
                  <div className="grid gap-3">
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      <div className="grid gap-2">
                        <Label>Node WebSocket URL</Label>
                        <Input
                          value={remoteNodeUrl}
                          onChange={(event) => setRemoteNodeUrl(event.target.value)}
                          placeholder="ws://127.0.0.1:4002"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>Node HTTP URL</Label>
                        <Input
                          value={remoteNodeHttpUrl}
                          onChange={(event) => setRemoteNodeHttpUrl(event.target.value)}
                          placeholder="http://127.0.0.1:4002"
                        />
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label>Hydra verification key</Label>
                      <Textarea
                        value={hydraVK}
                        onChange={(event) => setHydraVK(event.target.value)}
                        placeholder="Paste the remote Hydra verification key"
                        className="min-h-24 font-mono text-xs"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void runNodeCheck('remote')}
                        disabled={checkingNode === 'remote'}
                      >
                        {checkingNode === 'remote' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Wifi className="h-4 w-4" />
                        )}
                        Check remote node
                      </Button>
                      <NodeCheckResult result={remoteCheck} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-lg border p-4">
            <div className="grid gap-2 md:max-w-xs">
              <Label>Contestation period</Label>
              <Input
                type="number"
                min={1}
                value={contestationPeriod}
                onChange={(event) => setContestationPeriod(event.target.value)}
              />
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw />}
            Create head
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
