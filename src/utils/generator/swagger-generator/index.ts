import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from '@/utils/zod-openapi';
import { registerAdminPaths } from './registrars/admin';
import { registerPaymentPaths } from './registrars/payments';
import { registerInvoiceAndPurchasePaths } from './registrars/invoices-purchases';
import { registerRegistrySupportPaths } from './registrars/registry-support';
import { registerMonitoringPaths } from './registrars/monitoring';

extendZodWithOpenApi(z);

export function generateOpenAPI() {
	const registry = new OpenAPIRegistry();

	const apiKeyAuth = registry.registerComponent('securitySchemes', 'API-Key', {
		type: 'apiKey',
		in: 'header',
		name: 'token',
		description: 'API key authentication via header (token)',
	});

	registerAdminPaths({ registry, apiKeyAuth });
	registerPaymentPaths({ registry, apiKeyAuth });
	registerInvoiceAndPurchasePaths({ registry, apiKeyAuth });
	registerRegistrySupportPaths({ registry, apiKeyAuth });
	registerMonitoringPaths({ registry, apiKeyAuth });

	return new OpenApiGeneratorV3(registry.definitions).generateDocument({
		openapi: '3.0.0',
		info: {
			version: '1.0.0',
			title: 'Masumi Payment Service API',
			description:
				'A comprehensive payment service API for the Masumi ecosystem, providing secure payment processing, agent registry management, and wallet operations.',
		},
		servers: [{ url: './../api/v1/' }],
	});
}
