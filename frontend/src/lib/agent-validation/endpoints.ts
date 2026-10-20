export type ProbeEndpointName =
  | 'availability'
  | 'input_schema'
  | 'demo'
  | 'start_job'
  | 'status'
  | 'provide_input';

export type EndpointInput = 'jobId' | 'identifierFromPurchaser';

export type EndpointOption = {
  value: ProbeEndpointName;
  method: 'GET' | 'POST';
  path: string;
  label: string;
  description: string;
  /** Inputs the backend probe cannot run without. */
  needs: EndpointInput[];
};

export const ENDPOINT_OPTIONS: EndpointOption[] = [
  {
    value: 'availability',
    method: 'GET',
    path: '/availability',
    label: 'Availability',
    description:
      'What the registry polls to decide whether your agent is Online, Offline or Invalid.',
    needs: [],
  },
  {
    value: 'input_schema',
    method: 'GET',
    path: '/input_schema',
    label: 'Input schema',
    description: 'The form buyers fill in to start a job.',
    needs: [],
  },
  {
    value: 'demo',
    method: 'GET',
    path: '/demo',
    label: 'Demo (optional)',
    description: 'An example input and output buyers can preview.',
    needs: [],
  },
  {
    value: 'start_job',
    method: 'POST',
    path: '/start_job',
    label: 'Start job',
    description:
      'Starts a job with the input you give. The agent should create its payment and answer with the payment terms.',
    needs: ['identifierFromPurchaser'],
  },
  {
    value: 'status',
    method: 'GET',
    path: '/status',
    label: 'Job status',
    description: 'The status, and result or follow-up questions, of a job you started.',
    needs: ['jobId'],
  },
  {
    value: 'provide_input',
    method: 'POST',
    path: '/provide_input',
    label: 'Provide input (human in the loop)',
    description: 'Answers a job that is waiting for more input.',
    needs: ['jobId', 'identifierFromPurchaser'],
  },
];

export function endpointOption(value: ProbeEndpointName): EndpointOption {
  const option = ENDPOINT_OPTIONS.find((entry) => entry.value === value);
  if (option == null) throw new Error(`Unknown endpoint ${value}`);
  return option;
}

export function missingInputs(
  endpoint: ProbeEndpointName,
  values: Partial<Record<EndpointInput, string>>,
): EndpointInput[] {
  return endpointOption(endpoint).needs.filter(
    (input) => (values[input] ?? '').trim().length === 0,
  );
}
