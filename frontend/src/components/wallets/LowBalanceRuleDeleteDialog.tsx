import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { useLowBalanceRules } from '@/lib/hooks/useLowBalanceRules';
import { getDeleteRuleDialogDescription, getRuleAssetLabel } from './wallet-details-utils';

interface LowBalanceRuleDeleteDialogProps {
  rules: ReturnType<typeof useLowBalanceRules>;
  network: Parameters<typeof getRuleAssetLabel>[1];
  elevatedChildStack?: boolean;
}

export function LowBalanceRuleDeleteDialog({
  rules,
  network,
  elevatedChildStack,
}: LowBalanceRuleDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={!!rules.pendingDeleteRule}
      onClose={() => rules.setPendingDeleteRule(null)}
      elevatedGrandchildStack={elevatedChildStack}
      title={
        rules.pendingDeleteRule
          ? `Delete ${getRuleAssetLabel(rules.pendingDeleteRule.assetUnit, network)} rule?`
          : 'Delete low-balance rule?'
      }
      description={
        rules.pendingDeleteRule
          ? getDeleteRuleDialogDescription(rules.pendingDeleteRule, network)
          : 'Remove this low-balance rule?'
      }
      onConfirm={rules.handleConfirmDeleteLowBalanceRule}
      isLoading={
        rules.pendingDeleteRule != null && rules.mutatingRuleIds.has(rules.pendingDeleteRule.id)
      }
    />
  );
}
