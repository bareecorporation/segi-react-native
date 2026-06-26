// Global scope (Sentry parity): user, tags, extras, named contexts, and a breadcrumb
// ring buffer. State persists for the process and is merged into every event.
import type {
  SegiBreadcrumb,
  SegiBeforeBreadcrumbFn,
  SegiContexts,
  SegiUser,
} from './types';

let _user: SegiUser | null = null;
const _tags: Record<string, string> = {};
const _extras: Record<string, unknown> = {};
const _contexts: SegiContexts = {};

let _breadcrumbs: SegiBreadcrumb[] = [];
let _maxBreadcrumbs = 50;
let _beforeBreadcrumb: SegiBeforeBreadcrumbFn | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

/** Attach a user to all subsequent events. Pass `null` to clear. */
export function setSegiUser(user: SegiUser | null): void {
  _user = user;
}

export function getSegiUser(): SegiUser | null {
  return _user;
}

/** Set a single global tag. `null`/`undefined` removes it. */
export function setSegiTag(key: string, value: string | null | undefined): void {
  if (value == null) delete _tags[key];
  else _tags[key] = value;
}

/** Merge multiple global tags. */
export function setSegiTags(tags: Record<string, string>): void {
  Object.assign(_tags, tags);
}

/** Set a single global extra. `undefined` removes it. */
export function setSegiExtra(key: string, value: unknown): void {
  if (value === undefined) delete _extras[key];
  else _extras[key] = value;
}

/** Merge multiple global extras. */
export function setSegiExtras(extras: Record<string, unknown>): void {
  Object.assign(_extras, extras);
}

/** Set a named context group (e.g. `setSegiContext('order', { id })`). `null` removes it. */
export function setSegiContext(
  name: string,
  context: Record<string, unknown> | null,
): void {
  if (context === null) delete _contexts[name];
  else _contexts[name] = context;
}

export interface SegiScopeSnapshot {
  user: SegiUser | null;
  tags: Record<string, string>;
  extras: Record<string, unknown>;
  contexts: SegiContexts;
}

/** Configure several scope fields at once. */
export function configureSegiScope(update: Partial<SegiScopeSnapshot>): void {
  if (update.user !== undefined) _user = update.user;
  if (update.tags) Object.assign(_tags, update.tags);
  if (update.extras) Object.assign(_extras, update.extras);
  if (update.contexts) Object.assign(_contexts, update.contexts);
}

/** Reset all scope state and breadcrumbs. */
export function clearSegiScope(): void {
  _user = null;
  for (const k of Object.keys(_tags)) delete _tags[k];
  for (const k of Object.keys(_extras)) delete _extras[k];
  for (const k of Object.keys(_contexts)) delete _contexts[k];
  _breadcrumbs = [];
}

/** Read-only snapshot of the current scope, merged into each outgoing event. */
export function getSegiScope(): SegiScopeSnapshot {
  return {
    user: _user,
    tags: { ..._tags },
    extras: { ..._extras },
    contexts: { ..._contexts },
  };
}

/** Max breadcrumbs retained (and attached to events). */
export function setSegiMaxBreadcrumbs(max: number): void {
  _maxBreadcrumbs = Math.max(0, Math.floor(max));
  if (_breadcrumbs.length > _maxBreadcrumbs) {
    _breadcrumbs = _breadcrumbs.slice(_breadcrumbs.length - _maxBreadcrumbs);
  }
}

/** Register a hook to transform/drop breadcrumbs before they are recorded. */
export function setSegiBeforeBreadcrumb(fn: SegiBeforeBreadcrumbFn | null): void {
  _beforeBreadcrumb = fn;
}

/**
 * Record a breadcrumb. Stamped with a timestamp if absent, passed through the
 * `beforeBreadcrumb` hook, and stored in a ring buffer capped at `maxBreadcrumbs`.
 */
export function addSegiBreadcrumb(breadcrumb: SegiBreadcrumb): void {
  if (_maxBreadcrumbs <= 0) return;
  let b: SegiBreadcrumb = {
    level: 'info',
    ...breadcrumb,
    timestamp: breadcrumb.timestamp ?? nowIso(),
  };
  if (_beforeBreadcrumb) {
    try {
      const result = _beforeBreadcrumb(b);
      if (result == null) return;
      b = result;
    } catch {
      // ignore a throwing hook — keep the original breadcrumb
    }
  }
  _breadcrumbs.push(b);
  if (_breadcrumbs.length > _maxBreadcrumbs) _breadcrumbs.shift();
}

/** Convenience helper for navigation breadcrumbs. */
export function addSegiNavigationBreadcrumb(from: string | undefined, to: string): void {
  addSegiBreadcrumb({
    type: 'navigation',
    category: 'navigation',
    message: from ? `${from} → ${to}` : to,
    data: { from, to },
  });
}

/** Current breadcrumbs (oldest first). */
export function getSegiBreadcrumbs(): SegiBreadcrumb[] {
  return _breadcrumbs.slice();
}

export function clearSegiBreadcrumbs(): void {
  _breadcrumbs = [];
}
