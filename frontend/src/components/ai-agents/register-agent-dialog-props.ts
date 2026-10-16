import type { RegistryEntry } from '@/lib/api/generated';

export interface RegisterAIAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * When set, the dialog operates in update mode for the given agent: the
   * form pre-fills with the agent's current metadata, the selling wallet
   * picker is hidden (the asset's current managed holder signs the update),
   * and submission calls the V2 update endpoint. Leave undefined for the
   * default register flow.
   */
  editingAgent?: RegistryEntry | null;
  /**
   * Smart contract address of the payment source `editingAgent` belongs to.
   * Threaded through to the update call so the V2 lookup hits the right
   * source (the backend default fallback resolves to V1). Required when
   * `editingAgent` is provided.
   */
  editingAgentSmartContractAddress?: string;
  /**
   * When set (and `editingAgent` is not), the dialog operates in re-register
   * mode: it pre-fills from the given agent exactly like update mode, but
   * stays a fresh registration — the minting-wallet picker is shown and
   * submission calls the register endpoint, minting a BRAND-NEW asset with a
   * NEW agent identifier on the active payment source. Used to re-register a
   * previously deregistered agent.
   */
  prefillAgent?: RegistryEntry | null;
  /** Stack above an elevated parent (e.g. opened from the agent details dialog). */
  elevatedChildStack?: boolean;
}
