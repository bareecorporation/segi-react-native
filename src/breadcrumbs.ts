// Automatic breadcrumb instrumentation (Sentry parity): console, network
// (fetch + XMLHttpRequest), and app foreground/background transitions. Each
// instrument chains to the original implementation and is idempotent.
import { addSegiBreadcrumb } from './scope';
import type { SegiAutoBreadcrumbOptions, SegiLevel } from './types';

let _installed = false;

type AnyFn = (...args: unknown[]) => unknown;

function resolveOption(
  enable: boolean | SegiAutoBreadcrumbOptions | undefined,
  key: keyof SegiAutoBreadcrumbOptions,
): boolean {
  if (enable === false) return false;
  if (enable === undefined || enable === true) return true;
  return enable[key] !== false;
}

/** Install the enabled auto-instruments. Idempotent. */
export function installSegiAutoBreadcrumbs(
  enable: boolean | SegiAutoBreadcrumbOptions | undefined,
): void {
  if (_installed) return;
  if (enable === false) return;
  _installed = true;

  if (resolveOption(enable, 'console')) instrumentConsole();
  if (resolveOption(enable, 'network')) {
    instrumentFetch();
    instrumentXHR();
  }
  if (resolveOption(enable, 'appState')) instrumentAppState();
}

// --- console -----------------------------------------------------------------
function instrumentConsole(): void {
  const c = globalThis.console as unknown as Record<string, AnyFn> | undefined;
  if (!c) return;
  const levels: Array<[string, SegiLevel]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warning'],
    ['error', 'error'],
    ['debug', 'debug'],
  ];
  for (const [method, level] of levels) {
    const original = c[method];
    if (typeof original !== 'function' || (original as { __segi?: boolean }).__segi) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      try {
        addSegiBreadcrumb({
          type: 'console',
          category: 'console',
          level,
          message: args
            .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
            .join(' ')
            .slice(0, 1000),
        });
      } catch {
        // never break console
      }
      return original.apply(this, args);
    };
    (wrapped as { __segi?: boolean }).__segi = true;
    c[method] = wrapped;
  }
}

// --- fetch -------------------------------------------------------------------
function instrumentFetch(): void {
  const g = globalThis as Record<string, unknown>;
  const orig = g.fetch as AnyFn | undefined;
  if (typeof orig !== 'function' || (orig as { __segi?: boolean }).__segi) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const startedAt = Date.now();
    const input = args[0];
    const init = args[1] as { method?: string } | undefined;
    const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input);
    const method = (init?.method ?? (input as { method?: string })?.method ?? 'GET').toUpperCase();
    const result = orig.apply(this, args) as Promise<{ status?: number }>;
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<{ status?: number }>).then(
        (res) => recordHttp('fetch', method, url, res?.status, startedAt),
        () => recordHttp('fetch', method, url, undefined, startedAt, true),
      );
    }
    return result;
  };
  (wrapped as { __segi?: boolean }).__segi = true;
  g.fetch = wrapped;
}

// --- XMLHttpRequest ----------------------------------------------------------
function instrumentXHR(): void {
  const g = globalThis as Record<string, unknown>;
  const XHR = g.XMLHttpRequest as { prototype?: Record<string, unknown> } | undefined;
  const proto = XHR?.prototype as Record<string, unknown> | undefined;
  if (!proto) return;
  const origOpen = proto.open as AnyFn | undefined;
  const origSend = proto.send as AnyFn | undefined;
  if (typeof origOpen !== 'function' || typeof origSend !== 'function') return;
  if ((origOpen as { __segi?: boolean }).__segi) return;

  const wrappedOpen = function (this: Record<string, unknown>, ...args: unknown[]) {
    this.__segiMethod = String(args[0] ?? 'GET').toUpperCase();
    this.__segiUrl = String(args[1] ?? '');
    return origOpen.apply(this, args);
  };
  (wrappedOpen as { __segi?: boolean }).__segi = true;
  proto.open = wrappedOpen;

  const wrappedSend = function (this: Record<string, unknown>, ...args: unknown[]) {
    const startedAt = Date.now();
    const method = (this.__segiMethod as string) ?? 'GET';
    const url = (this.__segiUrl as string) ?? '';
    try {
      const addListener = this.addEventListener as AnyFn | undefined;
      addListener?.call(this, 'loadend', () => {
        recordHttp('xhr', method, url, this.status as number | undefined, startedAt);
      });
    } catch {
      // some XHR polyfills lack addEventListener — skip
    }
    return origSend.apply(this, args);
  };
  (wrappedSend as { __segi?: boolean }).__segi = true;
  proto.send = wrappedSend;
}

function recordHttp(
  kind: 'fetch' | 'xhr',
  method: string,
  url: string,
  status: number | undefined,
  startedAt: number,
  errored = false,
): void {
  try {
    const level: SegiLevel =
      errored || (status != null && status >= 500)
        ? 'error'
        : status != null && status >= 400
          ? 'warning'
          : 'info';
    addSegiBreadcrumb({
      type: 'http',
      category: kind,
      level,
      message: `${method} ${stripQuery(url)}${status != null ? ` [${status}]` : errored ? ' [failed]' : ''}`,
      data: {
        method,
        url: stripQuery(url),
        status_code: status,
        duration_ms: Date.now() - startedAt,
      },
    });
  } catch {
    // swallow
  }
}

// --- AppState ----------------------------------------------------------------
function instrumentAppState(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rn = require('react-native') as {
      AppState?: { addEventListener?: (t: string, cb: (s: string) => void) => void; currentState?: string };
    };
    const AppState = rn?.AppState;
    if (!AppState?.addEventListener) return;
    let last = AppState.currentState;
    AppState.addEventListener('change', (next: string) => {
      try {
        addSegiBreadcrumb({
          type: 'lifecycle',
          category: 'app.lifecycle',
          message: `app ${next}`,
          data: { from: last, to: next },
        });
        last = next;
      } catch {
        // swallow
      }
    });
  } catch {
    // react-native absent — skip
  }
}

// --- helpers -----------------------------------------------------------------
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
