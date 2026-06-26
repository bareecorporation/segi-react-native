import { scrubSegiPayload } from './scrub';
import {
  getStoredNativeCrashes,
  installNativeHandlers,
  type NativeStoredCrash,
} from './native';
import type {
  SegiBeforeSendFn,
  SegiConfig,
  SegiEventContext,
  SegiLevel,
} from './types';

const DEFAULT_INGEST_URL = 'https://segiapi.extn.ai/api/ingest/events';
const DEFAULT_TIMEOUT_MS = 3000;

interface ResolvedConfig {
  projectKey: string;
  ingestUrl: string;
  environment: string;
  release: string | undefined;
  enabled: boolean;
  timeoutMs: number;
  debug: boolean;
  defaultTags: Record<string, string> | undefined;
}

let _config: ResolvedConfig | null = null;
let _beforeSend: SegiBeforeSendFn | null = null;

function detectRuntime(): string {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.HermesInternal !== 'undefined' && g.HermesInternal !== null) return 'hermes';
  return 'jsc';
}

function debugLog(...args: unknown[]): void {
  if (_config?.debug) {
    // eslint-disable-next-line no-console
    console.debug('[segi]', ...args);
  }
}

/**
 * Initialise the SDK. Call once at app startup, before installing global handlers.
 * Safe to call again to update configuration.
 */
export function initSegi(config: SegiConfig): void {
  const projectKey = (config.projectKey ?? '').trim();
  _config = {
    projectKey,
    ingestUrl: config.ingestUrl ?? DEFAULT_INGEST_URL,
    environment: config.environment ?? 'production',
    release: config.release,
    enabled: config.enabled !== false && projectKey.length > 0,
    timeoutMs:
      typeof config.timeoutMs === 'number' && config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    debug: config.debug === true,
    defaultTags: config.defaultTags,
  };
  if (!projectKey) {
    debugLog('init called without projectKey — SDK stays disabled');
    return;
  }

  // Native crash tracking: install handlers + replay crashes from a previous launch.
  if (config.enableNativeCrashTracking !== false) {
    installNativeHandlers();
    void flushNativeCrashes();
  }
}

/**
 * Build a synthetic Error from a persisted native crash and report it. Native crashes
 * are always fatal/unhandled and tagged with their origin (`native-ios` / `native-android`).
 */
function reportNativeCrash(crash: NativeStoredCrash): void {
  const err = new Error(crash.message || crash.name || 'Native crash');
  err.name = crash.name || 'NativeError';
  if (crash.stack) err.stack = crash.stack;
  captureSegiException(err, {
    level: 'fatal',
    handled: false,
    tags: { source: crash.platform },
    extra: { ...crash.extra, nativeTimestamp: crash.timestamp },
  });
}

/**
 * Read native crashes persisted from previous launches and forward them to Segi.
 * Called automatically by `initSegi`; exposed for manual flushing. Returns the count.
 */
export async function flushNativeCrashes(): Promise<number> {
  if (!isSegiEnabled()) return 0;
  const crashes = await getStoredNativeCrashes();
  for (const crash of crashes) reportNativeCrash(crash);
  if (crashes.length > 0) debugLog(`flushed ${crashes.length} native crash(es)`);
  return crashes.length;
}

/** Whether the SDK is initialised and enabled. */
export function isSegiEnabled(): boolean {
  return _config !== null && _config.enabled;
}

/** Log the current SDK status (masked key) — useful at boot. */
export function logSegiStatus(): void {
  if (!_config) {
    // eslint-disable-next-line no-console
    console.log('[segi] not initialised (call initSegi first)');
    return;
  }
  if (!_config.enabled) {
    // eslint-disable-next-line no-console
    console.log('[segi] disabled (enabled=false or missing projectKey)');
    return;
  }
  const masked = _config.projectKey.slice(0, 16) + '…';
  // eslint-disable-next-line no-console
  console.log(
    `[segi] enabled (runtime=${detectRuntime()}, env=${_config.environment}, key=${masked})`,
  );
}

/** Register a transform/drop hook applied right before send. */
export function setSegiBeforeSend(fn: SegiBeforeSendFn | null): void {
  _beforeSend = fn;
}

function buildContext(ctx: SegiEventContext, cfg: ResolvedConfig) {
  const tags =
    cfg.defaultTags || ctx.tags ? { ...cfg.defaultTags, ...ctx.tags } : undefined;
  return {
    tags,
    base: {
      platform: 'react-native',
      runtime: detectRuntime(),
      environment: cfg.environment,
      release: cfg.release,
      url: ctx.screen ?? undefined,
      handled: ctx.handled,
      context: {
        screen: ctx.screen ?? undefined,
        userId: ctx.user?.id != null ? String(ctx.user.id) : undefined,
        userEmail: ctx.user?.email,
        username: ctx.user?.username,
      },
      extra: ctx.extra,
    },
  };
}

/**
 * Capture an exception. Fire-and-forget — never throws and never blocks the caller.
 */
export function captureSegiException(err: unknown, ctx: SegiEventContext = {}): void {
  const cfg = _config;
  if (!cfg || !cfg.enabled) return;

  const isError = err instanceof Error;
  const message = isError ? err.message : String(err);
  const errorName = isError ? err.name : 'Error';
  const stack = isError ? err.stack : undefined;

  const { tags, base } = buildContext(ctx, cfg);
  const level: SegiLevel = ctx.level ?? 'error';

  void sendSegiEvent(
    { type: 'error', level, message, errorName, stack, tags, ...base },
    cfg,
  );
}

/**
 * Capture a plain message. Fire-and-forget — never throws and never blocks the caller.
 * Default level is `info`.
 */
export function captureSegiMessage(message: string, ctx: SegiEventContext = {}): void {
  const cfg = _config;
  if (!cfg || !cfg.enabled) return;

  const { tags, base } = buildContext(ctx, cfg);
  const level: SegiLevel = ctx.level ?? 'info';

  void sendSegiEvent({ type: 'message', level, message, tags, ...base }, cfg);
}

async function sendSegiEvent(
  payload: Record<string, unknown>,
  cfg: ResolvedConfig,
): Promise<void> {
  // 1) stamp timestamp + drop undefined-valued keys for a compact body
  const withTs: Record<string, unknown> = { ...payload, timestamp: new Date().toISOString() };

  // 2) PII scrub
  const scrubbed = scrubSegiPayload(withTs) as Record<string, unknown>;

  // 3) beforeSend hook
  let finalPayload = scrubbed;
  if (_beforeSend) {
    try {
      const result = _beforeSend(scrubbed);
      if (result === null || result === undefined) {
        debugLog('dropped by beforeSend');
        return;
      }
      finalPayload = result;
    } catch (hookErr) {
      debugLog('beforeSend threw — sending scrubbed original', hookErr);
    }
  }

  // 4) network send (best-effort, short-circuited timeout)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-segi-project-key': cfg.projectKey,
      },
      body: JSON.stringify(finalPayload),
      signal: controller.signal,
    });
    if (res.status !== 202 && !res.ok) {
      debugLog('ingest failed', res.status);
    }
  } catch (e) {
    debugLog('ingest error', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
