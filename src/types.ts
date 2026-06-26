export type SegiLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface SegiConfig {
  /** Project ingest key (`segi_pk_live_…`). Required — without it the SDK stays disabled. */
  projectKey: string;
  /** Override the ingest endpoint. Default `https://segiapi.extn.ai/api/ingest/events`. */
  ingestUrl?: string;
  /** Logical environment, e.g. `production` | `staging` | `development`. Default `production`. */
  environment?: string;
  /** Release / app version (e.g. native app version or CodePush label). */
  release?: string;
  /** Master kill switch. Default `true`. */
  enabled?: boolean;
  /** Per-event network timeout in ms. Default `3000`. */
  timeoutMs?: number;
  /** Emit `console.debug` diagnostics for ingest/drop/error. Default `false`. */
  debug?: boolean;
  /** Tags attached to every event. */
  defaultTags?: Record<string, string>;
  /**
   * Install native (iOS/Android) crash handlers and replay crashes persisted from a
   * previous launch. Requires the native module to be linked. Default `true`.
   */
  enableNativeCrashTracking?: boolean;
}

export interface SegiUser {
  id?: string | number;
  email?: string;
  username?: string;
}

export interface SegiEventContext {
  /** Severity. Defaults: exceptions → `error`, messages → `info`. */
  level?: SegiLevel;
  /** Per-event tags (merged over `defaultTags`). */
  tags?: Record<string, string>;
  /** Arbitrary structured context. PII-scrubbed before send. */
  extra?: Record<string, unknown>;
  /** End user attached to the event. */
  user?: SegiUser;
  /** Current screen / route name. */
  screen?: string | null;
  /** `false` for crashes (unhandled), `true` for caught errors. */
  handled?: boolean;
}

/**
 * Transform an event right before it is sent, or return `null`/`undefined` to drop it.
 * Throwing inside the hook is swallowed and the (scrubbed) original event is sent.
 */
export type SegiBeforeSendFn = (
  event: Record<string, unknown>,
) => Record<string, unknown> | null | undefined;
