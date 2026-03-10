import { setupTracing } from '@/tracing';

try {
	await setupTracing();
	await import('@/app');
} catch (error) {
	console.error('Failed to bootstrap application', error);
	process.exitCode = 1;
	throw error;
}
