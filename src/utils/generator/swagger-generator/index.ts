import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from '@masumi/payment-core/zod';
import { registerAdminPaths } from './registrars/admin';
import { registerPaymentPaths } from './registrars/payments';
import { registerInvoiceAndPurchasePaths } from './registrars/invoices-purchases';
import { registerRegistrySupportPaths } from './registrars/registry-support';
// Colocated docs: these route areas keep their OpenAPI docs next to their
// schemas/handlers (src/routes/api/<area>/docs.ts). The remaining ./registrars
// files span multiple route areas and are migrated area-by-area.
import { registerRegistryInboxSupportPaths } from '@/routes/api/registry-inbox/docs';
import { registerMonitoringPaths } from '@/routes/api/monitoring/docs';
import { registerX402Paths } from '@/routes/api/x402/docs';
import { registerX402ManagementPaths } from '@/routes/api/x402/management-docs';

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
	registerRegistryInboxSupportPaths({ registry, apiKeyAuth });
	registerMonitoringPaths({ registry, apiKeyAuth });
	registerX402Paths({ registry, apiKeyAuth });
	registerX402ManagementPaths({ registry, apiKeyAuth });

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
