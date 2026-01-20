import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'dist',
  basePath: '/admin',
  env: {
    NEXT_PUBLIC_PAYMENT_API_BASE_URL:
      process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL || '/api/v1',
  },
  images: {
    unoptimized: true,
  },
  // Ensure TypeScript errors are caught during build
  // This matches CI behavior where caches don't exist
  typescript: {
    // Don't ignore build errors - fail the build on TypeScript errors
    ignoreBuildErrors: false,
  },
  // Note: eslint config was removed as it's no longer supported in Next.js 16
};

export default nextConfig;
