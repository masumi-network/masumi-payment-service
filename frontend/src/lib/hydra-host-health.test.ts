import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hydraHostHealthProblems, summarizeHydraHostHealth } from './hydra-host-health';

test('a node with no recorded error has no problems', () => {
  assert.deepEqual(hydraHostHealthProblems(null), []);
});

test('each line of the recorded error is one problem', () => {
  assert.deepEqual(hydraHostHealthProblems('wrong network\nwrong version\n'), [
    'wrong network',
    'wrong version',
  ]);
});

// An unreachable node records the network error, which is a single line.
test('a single-line error is one problem', () => {
  assert.deepEqual(hydraHostHealthProblems('connect ECONNREFUSED'), ['connect ECONNREFUSED']);
});

test('the toast shows a single problem as is', () => {
  assert.equal(summarizeHydraHostHealth(['wrong network'], 'unreachable'), 'wrong network');
});

test('the toast counts several problems', () => {
  assert.match(summarizeHydraHostHealth(['a', 'b', 'c'], 'unreachable'), /^3 checks failed/);
});

test('the toast falls back when nothing was recorded', () => {
  assert.equal(
    summarizeHydraHostHealth([], 'node could not be reached'),
    'node could not be reached',
  );
});
