/**
 * The release this payment node runs, against the newest published one.
 *
 * Shown even when nothing is known, as "not reported" or "not checked": an
 * empty space would read as "up to date".
 */

import { useReleaseStatus } from '@/lib/hooks/useReleaseStatus';
import { formatRelease } from '@/lib/release';

export function ServiceReleaseLine() {
  const { releaseStatus, isLoading } = useReleaseStatus();
  if (isLoading) return null;

  const running = releaseStatus
    ? (formatRelease(releaseStatus.service) ?? 'not reported')
    : 'not reported';
  const latest = releaseStatus?.latest ?? null;

  return (
    <p className="mt-1 text-xs text-muted-foreground">
      Payment node <span className="font-mono">{running}</span> · latest{' '}
      {latest === null ? 'not checked' : latest.version}
      {releaseStatus?.service.updateAvailable === true && latest !== null && (
        <>
          {' '}
          ·{' '}
          <a
            href={latest.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-amber-600 hover:underline"
          >
            Update available
          </a>
        </>
      )}
    </p>
  );
}
