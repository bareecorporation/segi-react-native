import { captureSegiException } from './client';
import { enableRejectionTracking } from './rejection-tracking';

// Minimal ambient shape for React Native's global ErrorUtils (avoids a hard dep on RN types).
type ErrorUtilsLike = {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler: (cb: (error: unknown, isFatal?: boolean) => void) => void;
};

export interface InstallHandlersOptions {
  /** Capture uncaught JS errors via `ErrorUtils`. Default `true`. */
  handleUncaughtErrors?: boolean;
  /** Capture unhandled promise rejections (best-effort). Default `true`. */
  handlePromiseRejections?: boolean;
}

let _installed = false;

/**
 * Install global crash handlers so uncaught errors and unhandled promise rejections
 * are reported to Segi automatically. Call once, after `initSegi`. Idempotent.
 *
 * - Uncaught errors chain to any previously-registered `ErrorUtils` handler.
 * - Fatal crashes are reported at level `fatal`, others at `error`.
 */
export function installSegiGlobalHandlers(options: InstallHandlersOptions = {}): void {
  if (_installed) return;
  _installed = true;

  const g = globalThis as Record<string, unknown>;

  // 1) Uncaught JS errors via ErrorUtils
  if (options.handleUncaughtErrors !== false) {
    const EU = g.ErrorUtils as ErrorUtilsLike | undefined;
    if (EU && typeof EU.setGlobalHandler === 'function') {
      const previous =
        typeof EU.getGlobalHandler === 'function' ? EU.getGlobalHandler() : undefined;
      EU.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        try {
          captureSegiException(error, {
            level: isFatal ? 'fatal' : 'error',
            handled: false,
            tags: { source: 'ErrorUtils' },
          });
        } catch {
          // never let reporting break the crash path
        }
        if (typeof previous === 'function') {
          previous(error, isFatal);
        }
      });
    }
  }

  // 2) Unhandled promise rejections (best-effort across RN versions)
  if (options.handlePromiseRejections !== false) {
    installRejectionTracking(g);
  }
}

function installRejectionTracking(g: Record<string, unknown>): void {
  // Preferred: RN bundles the `promise` polyfill with a rejection tracker. Resolved via a
  // static import (see ./rejection-tracking) so Metro registers the dependency.
  const installed = enableRejectionTracking({
    allRejections: true,
    onUnhandled: (_id, error) => {
      try {
        captureSegiException(error, {
          level: 'error',
          handled: false,
          tags: { source: 'unhandledRejection' },
        });
      } catch {
        // swallow
      }
    },
    onHandled: () => {},
  });
  if (installed) return;

  // Fallback: environments exposing the DOM `unhandledrejection` event.
  const addEventListener = g.addEventListener as
    | ((type: string, cb: (e: { reason?: unknown }) => void) => void)
    | undefined;
  if (typeof addEventListener === 'function') {
    try {
      addEventListener('unhandledrejection', (e) => {
        try {
          captureSegiException(e?.reason ?? e, {
            level: 'error',
            handled: false,
            tags: { source: 'unhandledRejection' },
          });
        } catch {
          // swallow
        }
      });
    } catch {
      // give up silently — reporting must never throw at install time
    }
  }
}
