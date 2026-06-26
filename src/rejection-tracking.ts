// Static binding to the `promise` polyfill's rejection tracker that React Native bundles.
//
// Same rationale as ./rn: a runtime `require('promise/setimmediate/rejection-tracking')`
// is not statically analyzable by Metro and resolves to "unknown module" under the New
// Architecture, so unhandled promise rejections silently stop being captured. A static
// import is registered by Metro and resolves on both architectures. For non-RN consumers
// (Node unit tests) this specifier is aliased to a stub (see vitest.config.ts).
import * as RejectionTracking from 'promise/setimmediate/rejection-tracking';

interface RejectionTrackingOptions {
  allRejections?: boolean;
  onUnhandled?: (id: unknown, error: unknown) => void;
  onHandled?: (id: unknown) => void;
}

/**
 * Enable the promise rejection tracker. Returns true when the tracker was installed,
 * false when unavailable so the caller can fall back to a DOM-style listener. Never throws.
 */
export function enableRejectionTracking(opts: RejectionTrackingOptions): boolean {
  try {
    const mod = RejectionTracking as unknown as {
      enable?: (o: RejectionTrackingOptions) => void;
      default?: { enable?: (o: RejectionTrackingOptions) => void };
    };
    const enable = mod?.enable ?? mod?.default?.enable;
    if (typeof enable === 'function') {
      enable(opts);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}
