export type SegiLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

/** Auto-breadcrumb instrumentation toggles. `true` enables all, `false` disables all. */
export interface SegiAutoBreadcrumbOptions {
  /** Record `console.*` calls as breadcrumbs. Default `true`. */
  console?: boolean;
  /** Record `fetch` / `XMLHttpRequest` calls as breadcrumbs. Default `true`. */
  network?: boolean;
  /** Record app foreground/background transitions. Default `true`. */
  appState?: boolean;
}

export interface SegiConfig {
  /** Project ingest key (`segi_pk_live_…`). Required — without it the SDK stays disabled. */
  projectKey: string;
  /** Override the ingest endpoint. Default `https://segiapi.extn.ai/api/ingest/events`. */
  ingestUrl?: string;
  /** Logical environment, e.g. `production` | `staging` | `development`. Default `production`. */
  environment?: string;
  /** Release / app version (e.g. native app version or CodePush label). */
  release?: string;
  /** Distribution / build number (Sentry parity). Optional. */
  dist?: string;
  /** Master kill switch. Default `true`. */
  enabled?: boolean;
  /** Per-event network timeout in ms. Default `3000`. */
  timeoutMs?: number;
  /** Emit `console.debug` diagnostics for ingest/drop/error. Default `false`. */
  debug?: boolean;
  /** Tags attached to every event. */
  defaultTags?: Record<string, string>;
  /**
   * Probability (0..1) that a given event is sent. Default `1`. Fatal/unhandled crashes
   * always bypass sampling so crashes are never dropped.
   */
  sampleRate?: number;
  /** Max breadcrumbs retained and attached to an event. Default `50`. */
  maxBreadcrumbs?: number;
  /**
   * Install automatic breadcrumb instrumentation (console, network, app state).
   * `true`/`false` toggles all, or pass an object for fine control. Default `true`.
   */
  enableAutoBreadcrumbs?: boolean | SegiAutoBreadcrumbOptions;
  /** Attach a synthetic stack trace to `captureSegiMessage` events. Default `false`. */
  attachStacktrace?: boolean;
  /**
   * Include potentially-identifying device context (locale, timezone, device name).
   * Default `false`. Network request bodies are never captured regardless.
   */
  sendDefaultPii?: boolean;
  /**
   * Install native (iOS/Android) crash handlers and replay crashes persisted from a
   * previous launch. Requires the native module to be linked. Default `true`.
   */
  enableNativeCrashTracking?: boolean;
  /** Suppress duplicate identical events within this window (ms). Default `2000`. 0 disables. */
  dedupeWindowMs?: number;
}

export interface SegiUser {
  id?: string | number;
  email?: string;
  username?: string;
  /** Free-form extra user attributes. */
  [key: string]: unknown;
}

export interface SegiEventContext {
  /** Severity. Defaults: exceptions → `error`, messages → `info`. */
  level?: SegiLevel;
  /** Event platform override. Native crash replays use `native-ios` / `native-android`. */
  platform?: 'react-native' | 'native-ios' | 'native-android' | string;
  /** Per-event tags (merged over global + `defaultTags`). */
  tags?: Record<string, string>;
  /** Arbitrary structured context. PII-scrubbed before send. */
  extra?: Record<string, unknown>;
  /** End user attached to the event (merged over the global scope user). */
  user?: SegiUser;
  /** Current screen / route name. */
  screen?: string | null;
  /** `false` for crashes (unhandled), `true` for caught errors. */
  handled?: boolean;
  /** Group similar events. Joined and sent as the event fingerprint. */
  fingerprint?: string[];
}

/** A breadcrumb — a timestamped trail entry attached to subsequent events. */
export interface SegiBreadcrumb {
  /** `default` | `navigation` | `http` | `console` | `ui` | `lifecycle` | custom. */
  type?: string;
  /** Dotted category, e.g. `console`, `fetch`, `xhr`, `navigation`, `ui.tap`. */
  category?: string;
  /** Human-readable message. */
  message?: string;
  /** Severity. Default `info`. */
  level?: SegiLevel;
  /** Structured data (status_code, url, method, …). PII-scrubbed before send. */
  data?: Record<string, unknown>;
  /** ISO timestamp. Auto-stamped if omitted. */
  timestamp?: string;
}

/** Named context groups (Sentry parity): device, os, app, etc. */
export type SegiContexts = Record<string, Record<string, unknown>>;

/**
 * Transform an event right before it is sent, or return `null`/`undefined` to drop it.
 * Throwing inside the hook is swallowed and the (scrubbed) original event is sent.
 */
export type SegiBeforeSendFn = (
  event: Record<string, unknown>,
) => Record<string, unknown> | null | undefined;

/**
 * Transform a breadcrumb before it is recorded, or return `null`/`undefined` to drop it.
 */
export type SegiBeforeBreadcrumbFn = (
  breadcrumb: SegiBreadcrumb,
) => SegiBreadcrumb | null | undefined;
