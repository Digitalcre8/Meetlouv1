import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@meetlou/domain', '@meetlou/records'],
};

export default config;
