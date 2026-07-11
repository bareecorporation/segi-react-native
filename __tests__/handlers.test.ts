import { afterEach, describe, expect, it, vi } from 'vitest';
import { initSegi } from '../src/client';
import { installSegiGlobalHandlers } from '../src/handlers';

describe('global handler parity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses Hermes native rejection tracking and observes both global error kinds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 202, ok: true });
    const previousHandler = vi.fn();
    let globalHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    let rejectionOptions:
      | { onUnhandled?: (id: unknown, error: unknown) => void }
      | undefined;
    const observer = vi.fn();

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('ErrorUtils', {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler: typeof globalHandler) => {
        globalHandler = handler;
      },
    });
    vi.stubGlobal('HermesInternal', {
      hasPromise: () => true,
      enablePromiseRejectionTracker: (options: typeof rejectionOptions) => {
        rejectionOptions = options;
      },
    });

    initSegi({ projectKey: 'k', dedupeWindowMs: 0 });
    installSegiGlobalHandlers({ onCapturedError: observer });

    const fatal = new Error('fatal');
    globalHandler?.(fatal, true);
    expect(previousHandler).toHaveBeenCalledWith(fatal, true);
    expect(observer).toHaveBeenCalledWith(fatal, {
      kind: 'uncaughtError',
      isFatal: true,
    });

    const rejection = new Error('rejected');
    rejectionOptions?.onUnhandled?.(7, rejection);
    expect(observer).toHaveBeenCalledWith(rejection, {
      kind: 'unhandledRejection',
      isFatal: false,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
