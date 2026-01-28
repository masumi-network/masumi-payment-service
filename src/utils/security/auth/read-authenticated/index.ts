import { authMiddleware } from '@/utils/middleware/auth-middleware';
import endpointFactory from '@/utils/generator/endpoint-factory';

export const readAuthenticatedEndpointFactory = endpointFactory.addMiddleware(
  authMiddleware('read'),
);
