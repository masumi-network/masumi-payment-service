import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasExampleOutputs,
  hasMeaningfulAuthor,
  hasMeaningfulCapability,
  hasMeaningfulLegal,
  shouldShowAdditionalDetailsSection,
} from './agent-metadata-visibility';

test('hasMeaningfulAuthor is false when all author fields are empty', () => {
  assert.equal(
    hasMeaningfulAuthor({ name: '', contactEmail: null, organization: null, contactOther: null }),
    false,
  );
  assert.equal(hasMeaningfulAuthor(undefined), false);
});

test('hasMeaningfulAuthor is true when any author field is set', () => {
  assert.equal(
    hasMeaningfulAuthor({
      name: 'Ada',
      contactEmail: null,
      organization: null,
      contactOther: null,
    }),
    true,
  );
  assert.equal(
    hasMeaningfulAuthor({
      name: '',
      contactEmail: 'a@b.c',
      organization: null,
      contactOther: null,
    }),
    true,
  );
});

test('hasMeaningfulLegal is false when every link is empty', () => {
  assert.equal(hasMeaningfulLegal({ terms: '', privacyPolicy: '', other: '' }), false);
  assert.equal(hasMeaningfulLegal(undefined), false);
});

test('hasMeaningfulLegal is true when any link is set', () => {
  assert.equal(
    hasMeaningfulLegal({ terms: 'https://example.com/terms', privacyPolicy: '', other: '' }),
    true,
  );
});

test('hasMeaningfulCapability follows the existing name-or-version rule', () => {
  assert.equal(hasMeaningfulCapability(undefined), false);
  assert.equal(hasMeaningfulCapability({ name: '', version: '' }), false);
  assert.equal(hasMeaningfulCapability({ name: 'gpt-4', version: '' }), true);
});

test('shouldShowAdditionalDetailsSection hides the block when all sections are empty', () => {
  assert.equal(
    shouldShowAdditionalDetailsSection({
      Author: { name: '', contactEmail: null, organization: null, contactOther: null },
      Legal: { terms: '', privacyPolicy: '', other: '' },
      Capability: { name: '', version: '' },
      ExampleOutputs: [],
    }),
    false,
  );
});

test('shouldShowAdditionalDetailsSection shows the block for partial metadata', () => {
  assert.equal(
    shouldShowAdditionalDetailsSection({
      Author: { name: 'Team', contactEmail: null, organization: null, contactOther: null },
      Legal: { terms: '', privacyPolicy: '', other: '' },
      Capability: { name: '', version: '' },
      ExampleOutputs: [],
    }),
    true,
  );
});

test('shouldShowAdditionalDetailsSection shows the block for complete metadata', () => {
  assert.equal(
    shouldShowAdditionalDetailsSection({
      Author: {
        name: 'Team',
        contactEmail: 'a@b.c',
        organization: 'Org',
        contactOther: 'https://x.y',
      },
      Legal: { terms: 'https://t', privacyPolicy: 'https://p', other: 'https://s' },
      Capability: { name: 'model', version: '1' },
      ExampleOutputs: [{ name: 'out', url: 'https://o', mimeType: 'text/plain' }],
    }),
    true,
  );
});

test('hasExampleOutputs is true only when outputs exist', () => {
  assert.equal(hasExampleOutputs([]), false);
  assert.equal(hasExampleOutputs([{ name: 'x', url: 'https://x', mimeType: 'text/plain' }]), true);
});
