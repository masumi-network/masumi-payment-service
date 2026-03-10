import { setupTracing } from '@/tracing';

export async function bootstrap() {
	await setupTracing();
	const { startApp } = await import('@/app');
	await startApp();
}

if (process.env.NODE_ENV !== 'test') {
	bootstrap().catch((error: unknown) => {
		console.error('Failed to bootstrap application', error);
		process.exitCode = 1;
	});
}
