import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { NextConfig } from 'next';
import { serviceWorkerHeaders, staticSecurityHeaders } from './lib/security-headers';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(appDir, '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // ESLint runs over the whole monorepo from the root (`npm run lint`), not inside the build.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // The design system is consumed from source.
  transpilePackages: ['@foresite/ui'],
  // Monorepo: trace files from the repo root and keep the theme folder in the
  // server bundle so the theme loader can read it at runtime on Vercel.
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: {
    '/**': ['../../themes/**/*'],
  },
  headers() {
    return Promise.resolve([
      { source: '/:path*', headers: staticSecurityHeaders },
      { source: '/sw.js', headers: serviceWorkerHeaders },
    ]);
  },
};

export default nextConfig;
