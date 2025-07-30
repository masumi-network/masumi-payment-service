import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';

const meter = metrics.getMeter('masumi-payment-metrics', '1.0.0');

// Custom counters for business events
export const paymentRequestCounter = meter.createCounter(
  'payment_requests_total',
  {
    description: 'Total number of payment requests',
  },
);

export const paymentSuccessCounter = meter.createCounter(
  'payment_success_total',
  {
    description: 'Total number of successful payments',
  },
);

export const paymentFailureCounter = meter.createCounter(
  'payment_failures_total',
  {
    description: 'Total number of failed payments',
  },
);

export const walletOperationCounter = meter.createCounter(
  'wallet_operations_total',
  {
    description: 'Total number of wallet operations',
  },
);

// Histograms for measuring durations
export const paymentProcessingDuration = meter.createHistogram(
  'payment_processing_duration_ms',
  {
    description: 'Time taken to process payments in milliseconds',
    unit: 'ms',
  },
);

export const databaseQueryDuration = meter.createHistogram(
  'database_query_duration_ms',
  {
    description: 'Time taken for database queries in milliseconds',
    unit: 'ms',
  },
);

export const cardanoTxDuration = meter.createHistogram(
  'cardano_tx_duration_ms',
  {
    description:
      'Time taken for Cardano transaction operations in milliseconds',
    unit: 'ms',
  },
);

// Gauges for current state
export const activePaymentGauge = meter.createUpDownCounter('active_payments', {
  description: 'Number of currently active payments',
});

export const walletBalanceGauge = meter.createObservableGauge(
  'wallet_balance_ada',
  {
    description: 'Current wallet balance in ADA',
  },
);

// Utility functions for easy instrumentation
export const recordPaymentRequest = (
  attributes: Record<string, string | number>,
) => {
  paymentRequestCounter.add(1, attributes);
};

export const recordPaymentSuccess = (
  attributes: Record<string, string | number>,
) => {
  paymentSuccessCounter.add(1, attributes);
  activePaymentGauge.add(-1, attributes);
};

export const recordPaymentFailure = (
  attributes: Record<string, string | number>,
  reason: string,
) => {
  paymentFailureCounter.add(1, { ...attributes, failure_reason: reason });
  activePaymentGauge.add(-1, attributes);
};

export const recordWalletOperation = (
  operation: string,
  attributes: Record<string, string | number>,
) => {
  walletOperationCounter.add(1, { ...attributes, operation });
};

export const measurePaymentProcessing = <T>(
  fn: () => Promise<T>,
  attributes: Record<string, string | number>,
): Promise<T> => {
  const start = Date.now();
  activePaymentGauge.add(1, attributes);

  return fn().finally(() => {
    const duration = Date.now() - start;
    paymentProcessingDuration.record(duration, attributes);
  });
};

export const measureDatabaseQuery = <T>(
  fn: () => Promise<T>,
  queryType: string,
  attributes: Record<string, string | number> = {},
): Promise<T> => {
  const start = Date.now();

  return fn().finally(() => {
    const duration = Date.now() - start;
    databaseQueryDuration.record(duration, {
      ...attributes,
      query_type: queryType,
    });
  });
};

export const measureCardanoTransaction = <T>(
  fn: () => Promise<T>,
  txType: string,
  attributes: Record<string, string | number> = {},
): Promise<T> => {
  const start = Date.now();

  return fn().finally(() => {
    const duration = Date.now() - start;
    cardanoTxDuration.record(duration, { ...attributes, tx_type: txType });
  });
};

// Custom span creation for detailed tracing
export const createCustomSpan = (
  name: string,
  attributes: Record<string, string | number> = {},
) => {
  const tracer = trace.getTracer('masumi-payment-tracer', '1.0.0');
  return tracer.startSpan(name, { attributes });
};

// Decorator for automatic instrumentation
export const instrument = (name: string) => {
  return (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value as (
      ...args: unknown[]
    ) => Promise<unknown>;

    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      const targetConstructor = (target as { constructor: { name: string } })
        .constructor;
      const span = createCustomSpan(
        `${targetConstructor.name}.${propertyKey}`,
        {
          method: name,
          class: targetConstructor.name,
        },
      );

      try {
        const result = await originalMethod.apply(this, args);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    };

    return descriptor;
  };
};
