// Bridge to the native crash-capture module (iOS Objective-C / Android Kotlin).
//
// React Native is an optional peer dependency, so we resolve it defensively: the core
// JS-only API keeps working even when `react-native` is absent (e.g. unit tests, web).

interface NativeStoredCrash {
  /** 'native-ios' | 'native-android' */
  platform: string;
  /** Exception class / signal name, e.g. 'NSInvalidArgumentException', 'SIGSEGV'. */
  name: string;
  message: string;
  /** Symbolicated (or raw) native call stack as a single string. */
  stack?: string;
  /** Epoch millis captured at crash time. */
  timestamp?: number;
  /** Thread / extra metadata. */
  extra?: Record<string, unknown>;
}

interface SegiNativeModule {
  /** Install native uncaught-exception / signal handlers. Idempotent on the native side. */
  install(): void;
  /** Return persisted crashes from previous launches and clear the store. */
  getStoredCrashesAndClear(): Promise<NativeStoredCrash[]>;
}

let _native: SegiNativeModule | null = null;
let _resolved = false;

function resolveNative(): SegiNativeModule | null {
  if (_resolved) return _native;
  _resolved = true;
  try {
    // Guarded require — avoids a hard dependency on react-native.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rn = require('react-native') as { NativeModules?: Record<string, unknown> };
    const mod = rn?.NativeModules?.SegiReactNative as SegiNativeModule | undefined;
    _native = mod ?? null;
  } catch {
    _native = null;
  }
  return _native;
}

/** Whether the native crash-capture module is linked into the app. */
export function isNativeCrashTrackingAvailable(): boolean {
  return resolveNative() !== null;
}

/** Install native crash handlers (no-op if the native module is unavailable). */
export function installNativeHandlers(): void {
  const native = resolveNative();
  if (!native) return;
  try {
    native.install();
  } catch {
    // never throw from install
  }
}

/** Read and clear persisted native crashes from previous launches. */
export async function getStoredNativeCrashes(): Promise<NativeStoredCrash[]> {
  const native = resolveNative();
  if (!native) return [];
  try {
    const crashes = await native.getStoredCrashesAndClear();
    return Array.isArray(crashes) ? crashes : [];
  } catch {
    return [];
  }
}

export type { NativeStoredCrash };
