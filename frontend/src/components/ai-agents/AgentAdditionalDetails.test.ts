import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAdditionalDetails } from './AgentAdditionalDetails';

type AgentMetadata = ComponentProps<typeof AgentAdditionalDetails>['agent'];

const emptyMetadata: AgentMetadata = {
  Author: { name: '', contactEmail: null, organization: null, contactOther: null },
  Legal: { terms: '', privacyPolicy: '', other: '' },
  Capability: { name: '', version: '' },
  ExampleOutputs: [],
};

function renderMetadata(agent: AgentMetadata) {
  return renderToStaticMarkup(createElement(AgentAdditionalDetails, { agent }));
}

test('empty metadata renders neither cards nor the Additional Details divider', () => {
  assert.equal(renderMetadata(emptyMetadata), '');
  assert.equal(
    renderMetadata({
      ...emptyMetadata,
      Author: { ...emptyMetadata.Author, name: '  ' },
      Legal: { terms: '\t', privacyPolicy: '', other: '' },
      Capability: { name: '', version: '  ' },
    }),
    '',
  );
});

test('an email alone renders the Author card and divider without empty metadata cards', () => {
  const markup = renderMetadata({
    ...emptyMetadata,
    Author: { ...emptyMetadata.Author, contactEmail: 'ada@example.com' },
  });
  assert.match(markup, /Additional Details/);
  assert.match(markup, />Author</);
  assert.match(markup, /href="mailto:ada@example.com"/);
  assert.doesNotMatch(markup, />Name<|>Legal<|>Capability<|>Example Outputs</);
  assert.doesNotMatch(markup, /md:grid-cols-2/);
});

test('author and legal content render together with usable external links', () => {
  const markup = renderMetadata({
    ...emptyMetadata,
    Author: { ...emptyMetadata.Author, name: 'Ada' },
    Legal: { terms: 'https://example.com/terms', privacyPolicy: '', other: '' },
  });
  assert.match(markup, /md:grid-cols-2/);
  assert.match(markup, />Ada</);
  assert.match(markup, />Legal</);
  assert.match(markup, /href="https:\/\/example.com\/terms"/);
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
  assert.match(markup, />example.com\/terms</);
});

test('capability and example output content render without author or legal cards', () => {
  const markup = renderMetadata({
    ...emptyMetadata,
    Capability: { name: 'Translation', version: '1' },
    ExampleOutputs: [{ name: 'Sample', mimeType: 'text/plain', url: 'https://example.com/sample' }],
  });
  assert.match(markup, /Additional Details/);
  assert.match(markup, />Capability</);
  assert.match(markup, />Example Outputs</);
  assert.match(markup, /Translation/);
  assert.match(markup, />Sample</);
  assert.match(markup, /href="https:\/\/example.com\/sample"/);
  assert.doesNotMatch(markup, />Author<|>Legal</);
});
