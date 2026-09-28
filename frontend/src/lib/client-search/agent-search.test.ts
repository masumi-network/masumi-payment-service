import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistryEntry } from '@/lib/api/generated';
import { filterAgentsClientSide } from './agent-search';

const fixed = {
  name: 'Summarizer',
  description: 'Summarizes documents',
  Tags: ['nlp', 'text'],
  state: 'RegistrationConfirmed',
  AgentPricing: { pricingType: 'Fixed', Pricing: [{ amount: '2000000', unit: '' }] },
} as unknown as RegistryEntry;

const free = {
  name: 'Echo',
  description: null,
  Tags: [],
  state: 'RegistrationRequested',
  AgentPricing: { pricingType: 'Free' },
} as unknown as RegistryEntry;

const names = (query: string) =>
  filterAgentsClientSide([fixed, free], query).map((agent) => agent.name);

test('tags need an exact match, like backend hasSome', () => {
  assert.deepEqual(names('nlp'), ['Summarizer']);
  assert.deepEqual(names('nl'), []);
});

test('pricing type matches by prefix', () => {
  assert.deepEqual(names('fr'), ['Echo']);
});

test('fixed pricing matches the ADA amount range', () => {
  assert.deepEqual(names('2'), ['Summarizer']);
  assert.deepEqual(names('3'), []);
});

test('name match is case-insensitive', () => {
  assert.deepEqual(names('  ECHO '), ['Echo']);
});
