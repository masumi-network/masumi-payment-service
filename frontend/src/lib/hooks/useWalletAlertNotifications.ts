import { useCallback, useMemo, useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceWalletsAll } from '@/lib/queries/useWallets';
import type { WalletListItem } from '@/lib/api/generated';

const ACKNOWLEDGED_WALLET_ALERTS_KEY = 'masumi_acknowledged_wallet_alerts';

type WalletAlertAcknowledgements = Record<string, Record<string, string>>;

export type WalletAlertNotification = {
  id: string;
  type: 'Purchasing' | 'Selling' | 'Funding';
  note: string | null;
  walletAddress: string;
  lowRuleCount: number;
  lastCheckedAt: Date | null;
  alertSignature: string;
};

function readAcknowledgements(): WalletAlertAcknowledgements {
  if (typeof window === 'undefined') {
    return {};
  }

  const raw = localStorage.getItem(ACKNOWLEDGED_WALLET_ALERTS_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAcknowledgements(value: WalletAlertAcknowledgements) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(ACKNOWLEDGED_WALLET_ALERTS_KEY, JSON.stringify(value));
}

function getAlertSignature(wallet: { LowBalanceSummary: { lowRuleCount: number } }): string {
  return String(wallet.LowBalanceSummary.lowRuleCount);
}

function walletDateValue(date: Date | null | undefined) {
  if (!date) {
    return 0;
  }

  return new Date(date).getTime();
}

function buildWalletAlerts(wallets: WalletListItem[]): WalletAlertNotification[] {
  return wallets
    .filter((wallet) => wallet.LowBalanceSummary?.isLow)
    .map((wallet) => ({
      id: wallet.id,
      type: wallet.type,
      note: wallet.note ?? null,
      walletAddress: wallet.walletAddress,
      lowRuleCount: wallet.LowBalanceSummary.lowRuleCount,
      lastCheckedAt: wallet.LowBalanceSummary.lastCheckedAt,
      alertSignature: getAlertSignature(wallet),
    }))
    .sort((a, b) => walletDateValue(b.lastCheckedAt) - walletDateValue(a.lastCheckedAt));
}

export function clearStoredWalletAlertAcknowledgements() {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.removeItem(ACKNOWLEDGED_WALLET_ALERTS_KEY);
}

export function useWalletAlertNotifications() {
  const { selectedPaymentSource } = useAppContext();
  const paymentSourceId = selectedPaymentSource?.id ?? null;
  const { wallets } = usePaymentSourceWalletsAll(paymentSourceId);
  const [acknowledgementsBySourceId, setAcknowledgementsBySourceId] =
    useState<WalletAlertAcknowledgements>(() => readAcknowledgements());

  const walletAlerts = useMemo(() => buildWalletAlerts(wallets), [wallets]);

  const unacknowledgedWalletAlerts = useMemo(() => {
    const acknowledgedByWalletId = paymentSourceId
      ? (acknowledgementsBySourceId[paymentSourceId] ?? {})
      : {};

    return walletAlerts.filter(
      (walletAlert) => acknowledgedByWalletId[walletAlert.id] !== walletAlert.alertSignature,
    );
  }, [acknowledgementsBySourceId, paymentSourceId, walletAlerts]);

  const acknowledgeWalletAlerts = useCallback(
    (walletAlertsToAcknowledge: WalletAlertNotification[] = walletAlerts) => {
      if (!paymentSourceId || walletAlertsToAcknowledge.length === 0) {
        return;
      }

      setAcknowledgementsBySourceId((currentAcknowledgementsBySourceId) => {
        const nextAcknowledgedByWalletId = {
          ...(currentAcknowledgementsBySourceId[paymentSourceId] ?? {}),
        };

        for (const walletAlert of walletAlertsToAcknowledge) {
          nextAcknowledgedByWalletId[walletAlert.id] = walletAlert.alertSignature;
        }

        const nextAcknowledgementsBySourceId = {
          ...currentAcknowledgementsBySourceId,
          [paymentSourceId]: nextAcknowledgedByWalletId,
        };

        writeAcknowledgements(nextAcknowledgementsBySourceId);
        return nextAcknowledgementsBySourceId;
      });
    },
    [paymentSourceId, walletAlerts],
  );

  return {
    walletAlerts,
    unacknowledgedWalletAlerts,
    activeWalletAlertCount: walletAlerts.length,
    unacknowledgedWalletAlertCount: unacknowledgedWalletAlerts.length,
    acknowledgeWalletAlerts,
  };
}
