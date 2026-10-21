/** Starting points for the schema tool. Both validate cleanly against the backend rules. */

export const INPUT_SCHEMA_EXAMPLE = JSON.stringify(
  {
    input_data: [
      {
        id: 'topic',
        type: 'text',
        name: 'Topic',
        data: { description: 'What should the agent research?', placeholder: 'Quantum computing' },
        validations: [{ validation: 'min', value: '3' }],
      },
      {
        id: 'language',
        type: 'option',
        name: 'Language',
        data: { values: ['English', 'German'] },
      },
      {
        id: 'depth',
        type: 'number',
        name: 'Depth (1-5)',
        validations: [
          { validation: 'min', value: '1' },
          { validation: 'max', value: '5' },
          { validation: 'format', value: 'integer' },
        ],
      },
      {
        id: 'include_sources',
        type: 'boolean',
        name: 'Include sources',
        validations: [{ validation: 'optional', value: 'true' }],
      },
    ],
  },
  null,
  2,
);

export const COWORKER_METADATA_EXAMPLE = JSON.stringify(
  {
    channels: { email: 'agent@example.com' },
    profile: {
      llm: ['Claude 3.5 Sonnet'],
      hosting: 'EU · Frankfurt',
      capabilities: ['Market Research'],
      examples: ['Plan a multi-channel campaign'],
    },
    offers: [
      {
        title: 'Competitive analysis',
        prompt: 'Run a competitive analysis of my top 3 competitors.',
        category: 'Research',
        outputs: [
          {
            type: 'pdf',
            url: 'https://example.com/samples/analysis.pdf',
            label: 'Competitive brief',
          },
        ],
      },
    ],
  },
  null,
  2,
);
