import { scrubSegiPayload } from './scrub';
import {
  getStoredNativeCrashes,
  installNativeHandlers,
  isNativeCrashTrackingAvailable,
  type NativeStoredCrash,
} from './native';
import {
  addSegiBreadcrumb,
  getSegiBreadcrumbs,
  getSegiScope,
  setSegiMaxBreadcrumbs,
} from './scope';
import { buildSegiContexts } from './context';
import { installSegiAutoBreadcrumbs } from './breadcrumbs';
import type {
  SegiBeforeSendFn,
  SegiConfig,
  SegiEventContext,
  SegiLevel,
  SegiUser,
} from './types';

const SDK_NAME = '@bareecorporation/segi-react-native';
const SDK_VERSION = '0.6.1';
const DEFAULT_INGEST_URL = 'https://segiapi.extn.ai/api/ingest/events';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BREADCRUMBS = 50;
const DEFAULT_DEDUPE_WINDOW_MS = 2000;
const RETRY_QUEUE_CAP = 30;

interface ResolvedConfig {
  projectKey: string;
  ingestUrl: string;
  environment: string;
  release: string | undefined;
  dist: string | undefined;
  enabled: boolean;
  timeoutMs: number;
  debug: boolean;
  defaultTags: Record<string, string> | undefined;
  sampleRate: number;
  attachStacktrace: boolean;
  sendDefaultPii: boolean;
  dedupeWindowMs: number;
}

let _config: ResolvedConfig | null = null;
let _beforeSend: SegiBeforeSendFn | null = null;

// dedup + in-session retry state
let _lastFingerprint: { key: string; at: number } | null = null;
const _retryQueue: Array<Record<string, unknown>> = [];

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
    dist: config.dist,
    enabled: config.enabled !== false && projectKey.length > 0,
    timeoutMs:
      typeof config.timeoutMs === 'number' && config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    debug: config.debug === true,
    defaultTags: config.defaultTags,
    sampleRate:
      typeof config.sampleRate === 'number' && config.sampleRate >= 0 && config.sampleRate <= 1
        ? config.sampleRate
        : 1,
    attachStacktrace: config.attachStacktrace === true,
    sendDefaultPii: config.sendDefaultPii === true,
    dedupeWindowMs:
      typeof config.dedupeWindowMs === 'number' && config.dedupeWindowMs >= 0
        ? config.dedupeWindowMs
        : DEFAULT_DEDUPE_WINDOW_MS,
  };
  if (!projectKey) {
    debugLog('init called without projectKey — SDK stays disabled');
    return;
  }

  setSegiMaxBreadcrumbs(
    typeof config.maxBreadcrumbs === 'number' ? config.maxBreadcrumbs : DEFAULT_MAX_BREADCRUMBS,
  );

  // Automatic breadcrumbs (console / network / app state). Default on.
  installSegiAutoBreadcrumbs(config.enableAutoBreadcrumbs);

  // Native crash tracking: install handlers + replay crashes from a previous launch.
  // The native module registry may not be ready at module-eval time (especially on
  // the New Architecture), so retry briefly until it resolves.
  if (config.enableNativeCrashTracking !== false) {
    setupNativeWhenReady();
  }
}

let _nativeSetupDone = false;
function setupNativeWhenReady(attempt = 0): void {
  if (_nativeSetupDone) return;
  if (isNativeCrashTrackingAvailable()) {
    _nativeSetupDone = true;
    installNativeHandlers();
    void flushNativeCrashes();
    debugLog('native crash tracking ready');
    return;
  }
  // Retry with backoff — on the New Architecture (bridgeless) the TurboModule
  // registry can take several seconds after boot to vend third-party modules,
  // so keep trying for ~30s before giving up.
  if (attempt < 40) {
    const delay = attempt < 5 ? 100 : attempt < 20 ? 500 : 1000;
    setTimeout(() => setupNativeWhenReady(attempt + 1), delay);
  } else {
    debugLog('native crash module unavailable after retries (JS-only capture)');
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
    `[segi] v${SDK_VERSION} enabled (runtime=${detectRuntime()}, env=${_config.environment}, key=${masked})`,
  );
}

/** Register a transform/drop hook applied right before send. */
export function setSegiBeforeSend(fn: SegiBeforeSendFn | null): void {
  _beforeSend = fn;
}

function mergeUser(ctxUser: SegiUser | undefined): SegiUser | undefined {
  const scopeUser = getSegiScope().user ?? undefined;
  if (!scopeUser && !ctxUser) return undefined;
  return { ...scopeUser, ...ctxUser };
}

function buildEnvelope(
  ctx: SegiEventContext,
  cfg: ResolvedConfig,
): Record<string, unknown> {
  const scope = getSegiScope();
  const user = mergeUser(ctx.user);
  // tags: defaultTags < global scope < per-event
  const tags = { ...cfg.defaultTags, ...scope.tags, ...ctx.tags };
  // extras: global scope < per-event
  const extra = { ...scope.extras, ...ctx.extra };
  // contexts: device/os/app/runtime + named scope contexts
  const contexts = { ...buildSegiContexts(cfg.sendDefaultPii), ...scope.contexts };

  return {
    platform: 'react-native',
    runtime: detectRuntime(),
    environment: cfg.environment,
    release: cfg.release,
    dist: cfg.dist,
    url: ctx.screen ?? undefined,
    handled: ctx.handled,
    tags: Object.keys(tags).length ? tags : undefined,
    user: user
      ? { ...user, id: user.id != null ? String(user.id) : undefined }
      : undefined,
    contexts: Object.keys(contexts).length ? contexts : undefined,
    breadcrumbs: getSegiBreadcrumbs(),
    fingerprint: ctx.fingerprint,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    // legacy/back-compat fields the segi event detail already surfaces
    context: {
      screen: ctx.screen ?? undefined,
      userId: user?.id != null ? String(user.id) : undefined,
      userEmail: user?.email,
      username: user?.username,
    },
    extra: Object.keys(extra).length ? extra : undefined,
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

  const level: SegiLevel = ctx.level ?? 'error';
  const base = buildEnvelope(ctx, cfg);

  void sendSegiEvent(
    { type: 'error', level, message, errorName, stack, ...base },
    cfg,
    level,
  );
}

/**
 * Capture a plain message. Fire-and-forget — never throws and never blocks the caller.
 * Default level is `info`.
 */
export function captureSegiMessage(message: string, ctx: SegiEventContext = {}): void {
  const cfg = _config;
  if (!cfg || !cfg.enabled) return;

  const level: SegiLevel = ctx.level ?? 'info';
  const base = buildEnvelope(ctx, cfg);
  const stack = cfg.attachStacktrace ? syntheticStack() : undefined;

  void sendSegiEvent({ type: 'message', level, message, stack, ...base }, cfg, level);
}

function syntheticStack(): string | undefined {
  const s = new Error().stack;
  if (!s) return undefined;
  // Drop the frames inside the SDK (this fn + captureSegiMessage).
  return s.split('\n').slice(3).join('\n');
}

function fingerprintKey(payload: Record<string, unknown>): string {
  const name = String(payload.errorName ?? payload.type ?? '');
  const msg = String(payload.message ?? '');
  const firstFrame = String(payload.stack ?? '').split('\n')[1] ?? '';
  return `${name}|${msg}|${firstFrame}`;
}

async function sendSegiEvent(
  payload: Record<string, unknown>,
  cfg: ResolvedConfig,
  level: SegiLevel,
): Promise<void> {
  // 0) sampling — crashes (fatal) always bypass so they are never dropped.
  if (level !== 'fatal' && cfg.sampleRate < 1 && Math.random() >= cfg.sampleRate) {
    debugLog('dropped by sampleRate');
    return;
  }

  // 0b) dedup — suppress identical consecutive events within the window.
  if (cfg.dedupeWindowMs > 0) {
    const key = fingerprintKey(payload);
    const now = Date.now();
    if (_lastFingerprint && _lastFingerprint.key === key && now - _lastFingerprint.at < cfg.dedupeWindowMs) {
      debugLog('dropped duplicate event');
      return;
    }
    _lastFingerprint = { key, at: now };
  }

  // 1) stamp timestamp + drop undefined-valued keys for a compact body
  const withTs: Record<string, unknown> = compact({ ...payload, timestamp: new Date().toISOString() });

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

  const ok = await postEvent(finalPayload, cfg);
  if (ok) {
    void flushRetryQueue(cfg);
  } else {
    enqueueRetry(finalPayload);
  }
}

async function postEvent(
  payload: Record<string, unknown>,
  cfg: ResolvedConfig,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-segi-project-key': cfg.projectKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 202 || res.ok) return true;
    debugLog('ingest failed', res.status);
    // 4xx (except 429) are client errors — not worth retrying.
    return res.status >= 400 && res.status < 500 && res.status !== 429 ? true : false;
  } catch (e) {
    debugLog('ingest error', e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function enqueueRetry(payload: Record<string, unknown>): void {
  _retryQueue.push(payload);
  if (_retryQueue.length > RETRY_QUEUE_CAP) _retryQueue.shift();
  debugLog(`queued for retry (${_retryQueue.length})`);
}

/**
 * Best-effort flush of events that failed to send earlier this session. Called
 * automatically after each successful send; safe to call manually (e.g. on
 * `AppState` 'active'). Returns the number of events flushed.
 */
export async function flushSegiRetryQueue(): Promise<number> {
  const cfg = _config;
  if (!cfg || !cfg.enabled) return 0;
  return flushRetryQueue(cfg);
}

async function flushRetryQueue(cfg: ResolvedConfig): Promise<number> {
  let flushed = 0;
  // Drain a snapshot; re-enqueue on repeated failure but stop to avoid a tight loop.
  const pending = _retryQueue.splice(0, _retryQueue.length);
  for (const ev of pending) {
    const ok = await postEvent(ev, cfg);
    if (ok) flushed++;
    else {
      enqueueRetry(ev);
      break;
    }
  }
  if (flushed > 0) debugLog(`flushed ${flushed} queued event(s)`);
  return flushed;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Re-export the manual breadcrumb API from the client surface for convenience.
export { addSegiBreadcrumb };
