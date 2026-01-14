import { metrics, trace } from '@opentelemetry/api';
import type { Counter, Histogram, UpDownCounter } from '@opentelemetry/api';
import { logger } from './logger';

const meterName = 'masumi-payment-metrics';
const meterVersion = '1.0.0';
let meter: ReturnType<typeof metrics.getMeter> | null = null;

const getMeter = () => {
  if (!meter) {
    meter = metrics.getMeter(meterName, meterVersion);
  }
  return meter;
};

let businessEndpointErrorCounter: Counter | null = null;
let apiRequestDuration: Histogram | null = null;
let apiErrorCounter: Counter | null = null;
let businessEndpointDuration: Histogram | null = null;
let businessEndpointSuccessCounter: Counter | null = null;
let blockchainStateTransitionDuration: Histogram | null = null;
let blockchainJourneyDuration: Histogram | null = null;
let blockchainStateTransitionCounter: Counter | null = null;
let activePaymentGauge: UpDownCounter | null = null;

const getBusinessEndpointErrorCounter = (): Counter => {
  if (!businessEndpointErrorCounter) {
    businessEndpointErrorCounter = getMeter().createCounter(
      'business_endpoint_errors_total',
      {
        description:
          'Total number of errors for business endpoints with detailed error information',
      },
    );
  }
  return businessEndpointErrorCounter;
};

const getApiRequestDuration = (): Histogram => {
  if (!apiRequestDuration) {
    apiRequestDuration = getMeter().createHistogram('api_request_duration_ms', {
      description:
        'Time taken for API requests from start to finish in milliseconds',
      unit: 'ms',
    });
  }
  return apiRequestDuration;
};

const getApiErrorCounter = (): Counter => {
  if (!apiErrorCounter) {
    apiErrorCounter = getMeter().createCounter('api_errors_total', {
      description: 'Total number of API errors by endpoint and error type',
    });
  }
  return apiErrorCounter;
};

const getBusinessEndpointDuration = (): Histogram => {
  if (!businessEndpointDuration) {
    businessEndpointDuration = getMeter().createHistogram(
      'business_endpoint_duration_ms',
      {
        description:
          'Time taken to process business endpoint requests from start to completion',
        unit: 'ms',
      },
    );
  }
  return businessEndpointDuration;
};

const getBusinessEndpointSuccessCounter = (): Counter => {
  if (!businessEndpointSuccessCounter) {
    businessEndpointSuccessCounter = getMeter().createCounter(
      'business_endpoint_success_total',
      {
        description: 'Total number of successful business endpoint requests',
      },
    );
  }
  return businessEndpointSuccessCounter;
};

const getBlockchainStateTransitionDuration = (): Histogram => {
  if (!blockchainStateTransitionDuration) {
    blockchainStateTransitionDuration = getMeter().createHistogram(
      'blockchain_state_transition_duration_ms',
      {
        description: 'Time between blockchain state transitions',
        unit: 'ms',
      },
    );
  }
  return blockchainStateTransitionDuration;
};

const getBlockchainJourneyDuration = (): Histogram => {
  if (!blockchainJourneyDuration) {
    blockchainJourneyDuration = getMeter().createHistogram(
      'blockchain_journey_duration_ms',
      {
        description:
          'Complete blockchain operation duration from request to confirmation',
        unit: 'ms',
      },
    );
  }
  return blockchainJourneyDuration;
};

const getBlockchainStateTransitionCounter = (): Counter => {
  if (!blockchainStateTransitionCounter) {
    blockchainStateTransitionCounter = getMeter().createCounter(
      'blockchain_state_transitions_total',
      {
        description: 'Total count of blockchain state transitions',
      },
    );
  }
  return blockchainStateTransitionCounter;
};

export const getActivePaymentGauge = (): UpDownCounter => {
  if (!activePaymentGauge) {
    activePaymentGauge = getMeter().createUpDownCounter('active_payments', {
      description: 'Number of currently active payments',
    });
  }
  return activePaymentGauge;
};

// Business Endpoint Types
type BusinessEndpoint = 'purchase' | 'registry' | 'wallet' | 'unknown';

// Helper function to identify business endpoints
const getBusinessEndpoint = (url: string): BusinessEndpoint => {
  if (url.includes('/api/v1/purchase')) return 'purchase';
  if (url.includes('/api/v1/registry')) return 'registry';
  if (url.includes('/api/v1/wallet')) return 'wallet';
  return 'unknown';
};

// Helper function to extract business error details from error messages
const extractBusinessErrorDetails = (
  error: Error | string,
  endpoint: BusinessEndpoint,
) => {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const lowerMessage = errorMessage.toLowerCase();

  // Purchase-specific errors
  if (endpoint === 'purchase') {
    if (lowerMessage.includes('payment source not found'))
      return {
        error_code: 'PAYMENT_SOURCE_NOT_FOUND',
        error_category: 'business_logic',
      };
    if (lowerMessage.includes('no valid purchasing wallets'))
      return {
        error_code: 'NO_WALLETS_AVAILABLE',
        error_category: 'business_logic',
      };
    if (lowerMessage.includes('invalid seller vkey'))
      return {
        error_code: 'INVALID_SELLER_VKEY',
        error_category: 'validation',
      };
    if (lowerMessage.includes('agent identifier not found'))
      return {
        error_code: 'AGENT_IDENTIFIER_NOT_FOUND',
        error_category: 'business_logic',
      };
    if (lowerMessage.includes('invalid blockchain identifier'))
      return {
        error_code: 'INVALID_BLOCKCHAIN_IDENTIFIER',
        error_category: 'validation',
      };
    if (
      lowerMessage.includes('input hash') &&
      lowerMessage.includes('valid hex')
    )
      return { error_code: 'INVALID_INPUT_HASH', error_category: 'validation' };
  }

  // Registry-specific errors
  if (endpoint === 'registry') {
    if (lowerMessage.includes('selling wallet not found'))
      return {
        error_code: 'SELLING_WALLET_NOT_FOUND',
        error_category: 'business_logic',
      };
    if (lowerMessage.includes('network and address combination not supported'))
      return {
        error_code: 'UNSUPPORTED_NETWORK_ADDRESS',
        error_category: 'business_logic',
      };
    if (lowerMessage.includes('registered wallet not found'))
      return {
        error_code: 'REGISTERED_WALLET_NOT_FOUND',
        error_category: 'business_logic',
      };
    if (lowerMessage.includes('asset not found'))
      return {
        error_code: 'ASSET_NOT_FOUND',
        error_category: 'business_logic',
      };
  }

  // Wallet-specific errors
  if (endpoint === 'wallet') {
    if (lowerMessage.includes('wallet not found'))
      return {
        error_code: 'WALLET_NOT_FOUND',
        error_category: 'business_logic',
      };
    if (lowerMessage.includes('invalid wallet type'))
      return {
        error_code: 'INVALID_WALLET_TYPE',
        error_category: 'validation',
      };
  }

  // Generic error categorization
  if (lowerMessage.includes('validation') || lowerMessage.includes('invalid'))
    return { error_code: 'VALIDATION_ERROR', error_category: 'validation' };
  if (lowerMessage.includes('unauthorized'))
    return { error_code: 'UNAUTHORIZED', error_category: 'auth' };
  if (lowerMessage.includes('forbidden'))
    return { error_code: 'FORBIDDEN', error_category: 'auth' };
  if (lowerMessage.includes('not found'))
    return { error_code: 'NOT_FOUND', error_category: 'business_logic' };

  return { error_code: 'UNKNOWN_ERROR', error_category: 'unknown' };
};

// Main recording functions for the new system
export const recordBusinessEndpointError = (
  endpoint: string,
  method: string,
  statusCode: number,
  error: Error | string,
  attributes: Record<string, string | number> = {},
) => {
  const businessEndpoint = getBusinessEndpoint(endpoint);
  const errorDetails = extractBusinessErrorDetails(error, businessEndpoint);

  getBusinessEndpointErrorCounter().add(1, {
    ...attributes,
    endpoint: businessEndpoint,
    full_endpoint: endpoint,
    method: method.toLowerCase(),
    status_code: statusCode,
    error_code: errorDetails.error_code,
    error_category: errorDetails.error_category,
    error_message: typeof error === 'string' ? error : error.message,
  });
};

export const recordBusinessEndpointSuccess = (
  endpoint: string,
  method: string,
  duration: number,
  attributes: Record<string, string | number> = {},
) => {
  const businessEndpoint = getBusinessEndpoint(endpoint);

  getBusinessEndpointSuccessCounter().add(1, {
    ...attributes,
    endpoint: businessEndpoint,
    full_endpoint: endpoint,
    method: method.toLowerCase(),
    duration_ms: duration,
  });
};

export const recordBusinessEndpointDuration = (
  endpoint: string,
  method: string,
  duration: number,
  statusCode: number,
  attributes: Record<string, string | number> = {},
) => {
  const businessEndpoint = getBusinessEndpoint(endpoint);

  getBusinessEndpointDuration().record(duration, {
    ...attributes,
    endpoint: businessEndpoint,
    full_endpoint: endpoint,
    method: method.toLowerCase(),
    status_code: statusCode,
    status: statusCode < 400 ? 'success' : 'failed',
  });
};

// Keep existing API error recording for general HTTP errors
export const recordApiError = (
  endpoint: string,
  method: string,
  statusCode: number,
  errorType: string,
  attributes: Record<string, string | number> = {},
) => {
  getApiErrorCounter().add(1, {
    ...attributes,
    endpoint,
    method,
    status_code: statusCode,
    error_type: errorType,
  });
};

// Utility function to measure business endpoint performance
export const measureBusinessEndpoint = <T>(
  fn: () => Promise<T>,
  endpoint: string,
  method: string,
  attributes: Record<string, string | number> = {},
): Promise<T> => {
  const start = Date.now();
  let statusCode = 200;

  return fn()
    .then((result) => {
      const duration = Date.now() - start;
      recordBusinessEndpointSuccess(endpoint, method, duration, attributes);
      recordBusinessEndpointDuration(
        endpoint,
        method,
        duration,
        statusCode,
        attributes,
      );
      return result;
    })
    .catch((error: unknown) => {
      const duration = Date.now() - start;
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;
      recordBusinessEndpointError(
        endpoint,
        method,
        statusCode,
        errorInstance,
        attributes,
      );
      recordBusinessEndpointDuration(
        endpoint,
        method,
        duration,
        statusCode,
        attributes,
      );
      throw error;
    });
};

// Simplified duration recording that focuses on business endpoints
export const recordBusinessProcessingDuration = (
  duration: number,
  endpoint: string,
  method: string,
  status: 'success' | 'failed',
  attributes: Record<string, string | number> = {},
) => {
  const businessEndpoint = getBusinessEndpoint(endpoint);

  getBusinessEndpointDuration().record(duration, {
    ...attributes,
    endpoint: businessEndpoint,
    full_endpoint: endpoint,
    method: method.toLowerCase(),
    status,
    operation: `${businessEndpoint}_${method.toLowerCase()}`,
  });
};

// Keep the existing API request duration recording (this one works)
export const recordApiRequestDuration = (
  duration: number,
  endpoint: string,
  method: string,
  statusCode: number,
  attributes: Record<string, string | number> = {},
) => {
  getApiRequestDuration().record(duration, {
    ...attributes,
    endpoint,
    method,
    status_code: statusCode,
    status: statusCode < 400 ? 'success' : 'failed',
  });

  // Also record business endpoint duration if it's a business endpoint
  const businessEndpoint = getBusinessEndpoint(endpoint);
  if (businessEndpoint !== 'unknown') {
    recordBusinessEndpointDuration(
      endpoint,
      method,
      duration,
      statusCode,
      attributes,
    );
  }
};

// Helper function to check if endpoint is a business endpoint
export const isBusinessEndpoint = (endpoint: string): boolean => {
  return getBusinessEndpoint(endpoint) !== 'unknown';
};

// Export the endpoint classifier for use in middleware
export { getBusinessEndpoint };

// Blockchain State Transition Recording Functions
export const recordStateTransition = (
  entityType: 'registration' | 'purchase' | 'payment',
  fromState: string,
  toState: string,
  duration: number,
  entityId: string,
  attributes: Record<string, string | number> = {},
) => {
  getBlockchainStateTransitionDuration().record(duration, {
    ...attributes,
    entity_type: entityType,
    entity_id: entityId,
    from_state: fromState,
    to_state: toState,
    transition: `${fromState}_to_${toState}`,
  });

  getBlockchainStateTransitionCounter().add(1, {
    ...attributes,
    entity_type: entityType,
    from_state: fromState,
    to_state: toState,
    transition: `${fromState}_to_${toState}`,
  });
};

export const recordBlockchainJourney = (
  entityType: 'registration' | 'purchase' | 'payment',
  totalDuration: number,
  finalState: string,
  entityId: string,
  attributes: Record<string, string | number> = {},
) => {
  getBlockchainJourneyDuration().record(totalDuration, {
    ...attributes,
    entity_type: entityType,
    entity_id: entityId,
    final_state: finalState,
    status:
      finalState.includes('Confirmed') || finalState.includes('Completed')
        ? 'success'
        : 'failed',
  });
};

let prismaDataTransferSize: Histogram | null = null;
let prismaQueryCounter: Counter | null = null;

// Create Prisma metrics lazily to avoid NoopHistogramMetric
const getPrismaMetrics = (): {
  prismaDataTransferSize: Histogram;
  prismaQueryCounter: Counter;
} => {
  if (!prismaDataTransferSize || !prismaQueryCounter) {
    const prismaMeter = metrics.getMeter('masumi-payment-metrics', '1.0.0');
    prismaDataTransferSize = prismaMeter.createHistogram(
      'prisma_data_transfer_size_bytes',
      {
        description: 'Size of data transferred from Prisma queries in bytes',
        unit: 'bytes',
      },
    );

    prismaQueryCounter = prismaMeter.createCounter('prisma_queries_total', {
      description: 'Total number of Prisma queries executed',
    });
  }

  if (!prismaDataTransferSize || !prismaQueryCounter) {
    throw new Error('Failed to initialize Prisma metrics');
  }

  return { prismaDataTransferSize, prismaQueryCounter };
};

// Record Prisma data transfer size
export const recordPrismaDataTransfer = (
  model: string,
  action: string,
  sizeBytes: number,
  rowCount?: number,
  attributes: Record<string, string | number> = {},
) => {
  // Match the pattern used by apiRequestDuration (which works)
  const histogramAttributes: Record<string, string | number> = {
    ...attributes,
    model,
    action,
    ...(rowCount !== undefined && { row_count: rowCount }),
  };

  const counterAttributes: Record<string, string | number> = {
    ...attributes,
    model,
    action,
  };

  try {
    const { prismaDataTransferSize, prismaQueryCounter } = getPrismaMetrics();
    prismaDataTransferSize.record(sizeBytes, histogramAttributes);
    prismaQueryCounter.add(1, counterAttributes);
  } catch (error) {
    // Log error but don't throw - metrics should not break the application
    logger.warn('Error recording Prisma metrics:', error);
  }
};

// Custom span creation for detailed tracing (keeping for advanced usage)
export const createCustomSpan = (
  name: string,
  attributes: Record<string, string | number> = {},
) => {
  const tracer = trace.getTracer('masumi-payment-tracer', '1.0.0');
  return tracer.startSpan(name, { attributes });
};
