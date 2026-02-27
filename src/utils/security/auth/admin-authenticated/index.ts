import { authMiddleware } from '@/utils/middleware/auth-middleware';
import endpointFactory from '@/utils/generator/endpoint-factory';

export const adminAuthenticatedEndpointFactory = endpointFactory.addMiddleware(authMiddleware('admin'));
