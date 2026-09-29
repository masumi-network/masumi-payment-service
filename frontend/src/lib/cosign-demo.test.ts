import assert from 'node:assert/strict';
import test from 'node:test';
import { needsReadToken, parseCosignDashboardUrl } from './cosign-demo';

test('parseCosignDashboardUrl allows https, and http only on loopback', () => {
  assert.equal(
    parseCosignDashboardUrl('https://cosign.exchain.network'),
    'https://cosign.exchain.network/',
  );
  assert.equal(parseCosignDashboardUrl('http://127.0.0.1:4600/'), 'http://127.0.0.1:4600/');
  assert.equal(parseCosignDashboardUrl('http://cosign.exchain.network'), null);
  assert.equal(parseCosignDashboardUrl('https://user:pass@cosign.exchain.network'), null);
  assert.equal(parseCosignDashboardUrl(''), null);
});

test('needsReadToken skips the local mock, which issues no tokens', () => {
  assert.equal(needsReadToken('https://cosign.exchain.network/'), true);
  assert.equal(needsReadToken('http://127.0.0.1:4600/'), false);
  assert.equal(needsReadToken('http://localhost:4600/'), false);
  assert.equal(needsReadToken(null), false);
});
