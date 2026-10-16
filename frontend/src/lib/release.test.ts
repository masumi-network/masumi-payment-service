import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelease, type DescribedRelease } from './release';

const release = (overrides: Partial<DescribedRelease>): DescribedRelease => ({
  version: null,
  commit: null,
  tag: null,
  commitsAhead: null,
  dirty: false,
  ...overrides,
});

test('formatRelease shows a tagged build as the bare tag', () => {
  assert.equal(
    formatRelease(release({ tag: '0.29.0', commitsAhead: 0, commit: 'a'.repeat(40) })),
    '0.29.0',
  );
});

test('formatRelease counts commits on top of the tag and names the commit', () => {
  assert.equal(
    formatRelease(release({ tag: '0.29.0', commitsAhead: 5, commit: 'abc1234def' })),
    '0.29.0 + 5 commits (abc1234)',
  );
  assert.equal(
    formatRelease(release({ tag: '0.29.0', commitsAhead: 1, commit: 'abc1234' })),
    '0.29.0 + 1 commit (abc1234)',
  );
});

test('formatRelease falls back to the commit when the build has no tag', () => {
  assert.equal(formatRelease(release({ commit: 'abc1234def567' })), 'abc1234');
});

test('formatRelease returns null when the build reports nothing', () => {
  assert.equal(formatRelease(release({})), null);
});

test('formatRelease marks a modified build', () => {
  assert.equal(
    formatRelease(release({ tag: '0.29.0', commitsAhead: 0, dirty: true })),
    '0.29.0 (modified)',
  );
});
