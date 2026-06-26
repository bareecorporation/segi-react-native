import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'error-boundary': 'src/error-boundary.tsx',
    'touch-boundary': 'src/touch-boundary.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // React Native is neither node nor browser; keep the output environment-agnostic.
  platform: 'neutral',
  target: 'es2020',
  // RN-resolved peers are kept external so Metro registers them as static dependencies
  // at app-bundle time (a runtime require() string is not statically analyzable — see
  // src/rn.ts / src/rejection-tracking.ts).
  external: ['react', 'react-native', 'promise', /^promise\//],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
