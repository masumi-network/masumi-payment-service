import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Ensure the `.openapi()` extension exists anywhere `z` is imported from this module.
// Important: this must run before any schemas call `.openapi(...)` at module load time.
extendZodWithOpenApi(z);

export { z };
