// Codegen spec for the Segi native module. This file exists so React Native's
// codegen generates the TurboModule interface, which makes the module register
// under the New Architecture (bridgeless). The JS SDK resolves the module
// defensively (TurboModuleRegistry/NativeModules) rather than importing this
// directly, so the SDK keeps working when react-native is absent.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** Install native uncaught-exception / signal handlers. Idempotent. */
  install(): void;
  /**
   * Return persisted crashes from previous launches (and clear the store) as a
   * JSON-encoded array string. JSON keeps the codegen surface trivial and avoids
   * object-array marshalling differences across the two architectures.
   */
  getStoredCrashesAndClear(): Promise<string>;
  /** Start the main-thread (ANR / app-hang) watchdog. */
  startAppHangWatchdog(thresholdMs: number): void;
  /** Stop the main-thread watchdog. */
  stopAppHangWatchdog(): void;
}

export default TurboModuleRegistry.get<Spec>('SegiReactNative');
