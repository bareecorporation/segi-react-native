import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'error-boundary': 'src/error-boundary.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // React Native is neither node nor browser; keep the output environment-agnostic.
  platform: 'neutral',
  target: 'es2020',
  external: ['react', 'react-native'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
