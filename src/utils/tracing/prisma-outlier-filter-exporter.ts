import type { HrTime } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

const PRISMA_SPAN_NAME_PREFIX = 'prisma:';

/** Converts OpenTelemetry HrTime duration [seconds, nanoseconds] to milliseconds. */
function hrTimeToMs(duration: HrTime): number {
	const [seconds, nanoseconds] = duration;
	return seconds * 1000 + nanoseconds / 1e6;
}

function isPrismaSpan(span: ReadableSpan): boolean {
	return span.name.startsWith(PRISMA_SPAN_NAME_PREFIX);
}

export interface PrismaOutlierFilterOptions {
	/** Only export Prisma spans with duration >= this (ms). Non-Prisma spans are always exported. */
	outlierThresholdMs: number;
	/** Max number of Prisma spans to export per minute (sliding window). */
	maxPrismaSpansPerMinute: number;
}

interface RateLimitWindow {
	count: number;
	windowStartMs: number;
}

/**
 * Wraps a SpanExporter and filters Prisma spans: only exports "outlier" Prisma spans
 * (duration >= threshold) and enforces a per-minute cap to limit log volume.
 */
export class PrismaOutlierFilterSpanExporter implements SpanExporter {
	private readonly delegate: SpanExporter;
	private readonly outlierThresholdMs: number;
	private readonly maxPrismaSpansPerMinute: number;
	private readonly windowMs = 60_000;
	private rateLimit: RateLimitWindow = { count: 0, windowStartMs: Date.now() };

	constructor(delegate: SpanExporter, options: PrismaOutlierFilterOptions) {
		this.delegate = delegate;
		this.outlierThresholdMs = options.outlierThresholdMs;
		this.maxPrismaSpansPerMinute = options.maxPrismaSpansPerMinute;
	}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		const now = Date.now();
		if (now - this.rateLimit.windowStartMs >= this.windowMs) {
			this.rateLimit = { count: 0, windowStartMs: now };
		}
		let prismaSlotsLeft = Math.max(0, this.maxPrismaSpansPerMinute - this.rateLimit.count);

		const toExport: ReadableSpan[] = [];
		for (const span of spans) {
			if (!isPrismaSpan(span)) {
				toExport.push(span);
				continue;
			}
			const durationMs = hrTimeToMs(span.duration);
			const isOutlier = durationMs >= this.outlierThresholdMs;
			if (isOutlier && prismaSlotsLeft > 0) {
				toExport.push(span);
				this.rateLimit.count += 1;
				prismaSlotsLeft -= 1;
			}
		}

		if (toExport.length === 0) {
			resultCallback({ code: ExportResultCode.SUCCESS });
			return;
		}
		this.delegate.export(toExport, resultCallback);
	}

	async shutdown(): Promise<void> {
		await this.delegate.shutdown();
	}

	async forceFlush(): Promise<void> {
		if (typeof this.delegate.forceFlush === 'function') {
			await this.delegate.forceFlush();
		}
	}
}
