import type { NextConfig } from 'next';
import * as path from 'path';

const nextConfig: NextConfig = {
  // Standalone build → minimal Node server in .next/standalone, copied by Dockerfile.
  // outputFileTracingRoot points to the monorepo root so Next bundles the workspace deps.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
};

export default nextConfig;
