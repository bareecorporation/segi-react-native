import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// React Native (and the `promise` rejection tracker it bundles) only resolve inside an RN
// app via Metro. The SDK imports them statically so Metro registers them as dependencies
// (see src/rn.ts, src/rejection-tracking.ts). For Node unit tests we alias those specifiers
// to lightweight stubs that mimic an environment where RN is absent.
export default defineConfig({
  test: {
    alias: {
      'react-native': fileURLToPath(new URL('./__tests__/__stubs__/react-native.ts', import.meta.url)),
      'promise/setimmediate/rejection-tracking': fileURLToPath(
        new URL('./__tests__/__stubs__/rejection-tracking.ts', import.meta.url),
      ),
    },
  },
});
