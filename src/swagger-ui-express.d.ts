import 'swagger-ui-express';

declare module 'swagger-ui-express' {
  interface SwaggerUiOptions {
    customJsStr?: string | string[] | undefined;
  }
}
