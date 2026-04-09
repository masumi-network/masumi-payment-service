import { useCallback, useEffect, useMemo, useState } from 'react';
import { type PaymentSource } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';

const ACKNOWLEDGED_WALLET_ALERTS_KEY = 'masumi_acknowledged_wallet_alerts';

type WalletAlertAcknowledgements = Record<string, Record<string, string>>;

export type WalletAlertNotification = {
  id: string;
  type: 'Purchasing' | 'Selling';
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

function buildWalletAlerts(selectedPaymentSource: PaymentSource | null): WalletAlertNotification[] {
  if (!selectedPaymentSource) {
    return [];
  }

  return [
    ...selectedPaymentSource.PurchasingWallets.map((wallet) => ({
      ...wallet,
      type: 'Purchasing' as const,
    })),
    ...selectedPaymentSource.SellingWallets.map((wallet) => ({
      ...wallet,
      type: 'Selling' as const,
    })),
  ]
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
  const [acknowledgedByWalletId, setAcknowledgedByWalletId] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!paymentSourceId) {
      setAcknowledgedByWalletId({});
      return;
    }

    const stored = readAcknowledgements();
    setAcknowledgedByWalletId(stored[paymentSourceId] ?? {});
  }, [paymentSourceId]);

  const walletAlerts = useMemo(
    () => buildWalletAlerts(selectedPaymentSource),
    [selectedPaymentSource],
  );

  const unacknowledgedWalletAlerts = useMemo(
    () =>
      walletAlerts.filter(
        (walletAlert) => acknowledgedByWalletId[walletAlert.id] !== walletAlert.alertSignature,
      ),
    [acknowledgedByWalletId, walletAlerts],
  );

  useEffect(() => {
    if (!paymentSourceId) {
      return;
    }

    const activeWalletIds = new Set(walletAlerts.map((walletAlert) => walletAlert.id));
    const nextAcknowledgedByWalletId = Object.fromEntries(
      Object.entries(acknowledgedByWalletId).filter(([walletId]) => activeWalletIds.has(walletId)),
    );

    if (
      Object.keys(nextAcknowledgedByWalletId).length ===
        Object.keys(acknowledgedByWalletId).length &&
      Object.entries(nextAcknowledgedByWalletId).every(
        ([walletId, signature]) => acknowledgedByWalletId[walletId] === signature,
      )
    ) {
      return;
    }

    setAcknowledgedByWalletId(nextAcknowledgedByWalletId);

    const stored = readAcknowledgements();
    stored[paymentSourceId] = nextAcknowledgedByWalletId;
    writeAcknowledgements(stored);
  }, [acknowledgedByWalletId, paymentSourceId, walletAlerts]);

  const acknowledgeWalletAlerts = useCallback(
    (walletAlertsToAcknowledge: WalletAlertNotification[] = walletAlerts) => {
      if (!paymentSourceId || walletAlertsToAcknowledge.length === 0) {
        return;
      }

      const nextAcknowledgedByWalletId = { ...acknowledgedByWalletId };

      for (const walletAlert of walletAlertsToAcknowledge) {
        nextAcknowledgedByWalletId[walletAlert.id] = walletAlert.alertSignature;
      }

      setAcknowledgedByWalletId(nextAcknowledgedByWalletId);

      const stored = readAcknowledgements();
      stored[paymentSourceId] = nextAcknowledgedByWalletId;
      writeAcknowledgements(stored);
    },
    [acknowledgedByWalletId, paymentSourceId, walletAlerts],
  );

  return {
    walletAlerts,
    unacknowledgedWalletAlerts,
    activeWalletAlertCount: walletAlerts.length,
    unacknowledgedWalletAlertCount: unacknowledgedWalletAlerts.length,
    acknowledgeWalletAlerts,
  };
}
