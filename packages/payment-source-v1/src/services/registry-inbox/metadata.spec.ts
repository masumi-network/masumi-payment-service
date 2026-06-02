import {
	INBOX_AGENT_REGISTRATION_METADATA_TYPE,
	normalizeInboxAgentRegistrationMetadata,
	parseInboxAgentRegistrationMetadata,
} from './metadata';

describe('inbox registry metadata', () => {
	it('parses valid inbox metadata including type', () => {
		expect(
			parseInboxAgentRegistrationMetadata({
				type: INBOX_AGENT_REGISTRATION_METADATA_TYPE,
				name: 'Inbox Agent',
				agentslug: 'inbox-agent',
				metadata_version: 1,
			}),
		).toEqual({
			name: 'Inbox Agent',
			description: null,
			agentSlug: 'inbox-agent',
			metadataVersion: 1,
		});
	});

	it('normalizes chunked metadata strings', () => {
		expect(
			normalizeInboxAgentRegistrationMetadata({
				type: INBOX_AGENT_REGISTRATION_METADATA_TYPE,
				name: ['Inbox ', 'Agent'],
				description: ['Managed ', 'holding wallet'],
				agentslug: 'inbox-agent',
				metadata_version: 1,
			}),
		).toEqual({
			name: 'Inbox Agent',
			description: 'Managed holding wallet',
			agentSlug: 'inbox-agent',
			metadataVersion: 1,
		});
	});

	it('rejects metadata without the inbox type discriminator', () => {
		expect(
			parseInboxAgentRegistrationMetadata({
				name: 'Inbox Agent',
				agentslug: 'inbox-agent',
				metadata_version: 1,
			}),
		).toBeNull();
	});
});
