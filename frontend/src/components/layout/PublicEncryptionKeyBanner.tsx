import { ShieldAlert } from 'lucide-react';
import { useSecurityStatus } from '@/lib/hooks/useSecurityStatus';

/**
 * Shown to admins on every page while ENCRYPTION_KEY is the public .env.example
 * value. It cannot be dismissed: the risk stays until the key changes.
 */
export function PublicEncryptionKeyBanner() {
  const { securityStatus } = useSecurityStatus();
  if (!securityStatus?.isEncryptionKeyPublic) return null;

  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-[1400px] gap-3 px-4 py-3 text-sm">
        <ShieldAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300"
          aria-hidden
        />
        <div className="space-y-1">
          <p className="font-medium">This service uses the public example encryption key</p>
          <p className="opacity-85">
            <code>ENCRYPTION_KEY</code> is the value from <code>.env.example</code>. Anyone with a
            copy of the database can decrypt every stored secret, including wallet keys, API keys
            and webhook tokens. Use this key only for a local or one-off setup. Do not change the
            key on this database: the stored secrets become unreadable and every API key stops
            working. For production, start a new database with a private key.
          </p>
        </div>
      </div>
    </div>
  );
}
