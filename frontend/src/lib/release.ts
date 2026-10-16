/**
 * How a build of this project is shown.
 *
 * One release tag builds the payment service and the Hydra Host image, so the
 * same format serves both.
 */

export type DescribedRelease = {
  /** `git describe` form, e.g. `0.29.0-5-gabc1234`, or a bare tag. */
  version: string | null;
  commit: string | null;
  /** Release tag the build starts from. */
  tag: string | null;
  /** Commits on top of `tag`; 0 for the tag itself. */
  commitsAhead: number | null;
  dirty: boolean;
};

export type ReleaseWithUpdate = DescribedRelease & {
  /** Null when it cannot be told: no latest release known, or no tag on the build. */
  updateAvailable: boolean | null;
};

export const UPGRADE_GUIDE_URL =
  'https://github.com/masumi-network/masumi-payment-service/blob/main/docs/hydra-host-upgrade.md';

const SHORT_COMMIT_LENGTH = 7;

export function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

/**
 * `0.29.0`, `0.29.0 + 5 commits (abc1234)`, or the bare commit when the build
 * carries no tag. Null only when the build reports nothing at all.
 */
export function formatRelease(release: DescribedRelease): string | null {
  const commit = release.commit === null ? null : shortCommit(release.commit);
  const dirty = release.dirty ? ', modified' : '';
  if (release.tag === null) {
    return commit === null ? null : `${commit}${dirty}`;
  }
  const ahead = release.commitsAhead ?? 0;
  if (ahead === 0) {
    return release.dirty ? `${release.tag} (modified)` : release.tag;
  }
  const commits = `${ahead} ${ahead === 1 ? 'commit' : 'commits'}`;
  return `${release.tag} + ${commits}${commit === null ? '' : ` (${commit}${dirty})`}`;
}
