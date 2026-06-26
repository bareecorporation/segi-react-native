// Node/vitest stub for the `react-native` peer. The real module only exists inside an
// RN app (resolved by Metro). Tests exercise the JS-only API, where RN is effectively
// absent, so the stub exposes the minimal shape the SDK probes for.
export const NativeModules: Record<string, unknown> = {};
export const TurboModuleRegistry = { get: (_name: string) => null };
export const Platform = { OS: 'ios', Version: '17.0', constants: {}, isTesting: true };
export const Dimensions = { get: (_dim: string) => ({ width: 0, height: 0, scale: 1, fontScale: 1 }) };
export const AppState = { addEventListener: (_t: string, _cb: (s: string) => void) => {}, currentState: 'active' };
