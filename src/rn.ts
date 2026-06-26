// Single resolution point for the React Native module.
//
// IMPORTANT: this uses a *static* `import` rather than a runtime `require('react-native')`.
// Under Metro (especially the New Architecture / bridgeless), module resolution is
// statically analyzed at bundle time — a dynamic `require('react-native')` with a string
// literal is NOT registered as a dependency of this chunk, so Metro throws
// "Requiring unknown module" at runtime and the peer resolves to null. A static import is
// registered by Metro and resolves correctly on both the old and new architectures.
//
// React Native is an optional peer dependency. For non-RN consumers (web bundlers, Node
// unit tests) this import is aliased/stubbed (see vitest.config.ts) or simply tree-shaken
// when the JS-only API is used, so the static import does not force a hard dependency.
import * as ReactNative from 'react-native';

interface RNModule {
  NativeModules?: Record<string, unknown>;
  TurboModuleRegistry?: { get?: (name: string) => unknown };
  Platform?: {
    OS?: string;
    Version?: string | number;
    constants?: Record<string, unknown>;
    isTesting?: boolean;
  };
  Dimensions?: {
    get?: (dim: string) => { width: number; height: number; scale?: number; fontScale?: number };
  };
  AppState?: {
    addEventListener?: (t: string, cb: (s: string) => void) => void;
    currentState?: string;
  };
  [key: string]: unknown;
}

/**
 * Return the React Native module, or null when RN is unavailable (web / Node tests).
 * Resolution never throws.
 */
export function getRN(): RNModule | null {
  try {
    const rn = ReactNative as unknown as RNModule;
    return rn && typeof rn === 'object' ? rn : null;
  } catch {
    return null;
  }
}
