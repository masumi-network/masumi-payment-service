import { setupTracing } from '@/tracing';

async function bootstrap() {
	await setupTracing();
	await import('@/app');
}

bootstrap().catch((error: unknown) => {
	console.error('Failed to bootstrap application', error);
	process.exitCode = 1;
});
