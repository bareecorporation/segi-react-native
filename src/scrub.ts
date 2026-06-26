// PII scrubbing — recursively masks sensitive keys before an event leaves the device.
// Ported from the canonical Segi server ingest client and kept dependency-free.

// Key names (case-insensitive, partial match) whose values are masked.
const SCRUB_KEY_PATTERNS: RegExp[] = [
  /^password$/i,
  /^passwd$/i,
  /token$/i,
  /secret$/i,
  /^apikey$/i,
  /^authorization$/i,
  /^cardnumber$/i,
  /^rrn$/i,
  /^residentnumber$/i,
];

// Header names removed entirely when a `headers` object is encountered.
const SCRUB_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

const FILTERED = '[Filtered]';

function shouldScrubKey(key: string): boolean {
  return SCRUB_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Recursively walk `value`, masking sensitive keys with `[Filtered]`. When a `headers`
 * object is found, sensitive header names are dropped. Returns new objects/arrays and
 * never mutates the input. Guards against cyclic references.
 */
export function scrubSegiPayload(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubSegiPayload(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (shouldScrubKey(k)) {
        result[k] = FILTERED;
      } else if (k.toLowerCase() === 'headers' && v !== null && typeof v === 'object') {
        const headers = v as Record<string, unknown>;
        const scrubbed: Record<string, unknown> = {};
        for (const [hk, hv] of Object.entries(headers)) {
          if (!SCRUB_HEADER_KEYS.has(hk.toLowerCase())) {
            scrubbed[hk] = scrubSegiPayload(hv, seen);
          }
        }
        result[k] = scrubbed;
      } else {
        result[k] = scrubSegiPayload(v, seen);
      }
    }
    return result;
  }
  return value;
}
