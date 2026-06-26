import { describe, expect, it } from 'vitest';
import { scrubSegiPayload } from '../src/scrub';

describe('scrubSegiPayload', () => {
  it('masks sensitive keys by name (partial + exact patterns)', () => {
    const out = scrubSegiPayload({
      password: 'pw',
      accessToken: 'abc',
      apiSecret: 'shh',
      apiKey: 'k',
      rrn: '900101-1234567',
      keep: 'visible',
    }) as Record<string, unknown>;

    expect(out.password).toBe('[Filtered]');
    expect(out.accessToken).toBe('[Filtered]');
    expect(out.apiSecret).toBe('[Filtered]');
    expect(out.apiKey).toBe('[Filtered]');
    expect(out.rrn).toBe('[Filtered]');
    expect(out.keep).toBe('visible');
  });

  it('drops sensitive headers inside a headers object', () => {
    const out = scrubSegiPayload({
      headers: { authorization: 'Bearer x', cookie: 'a=b', 'x-trace': 'ok' },
    }) as Record<string, Record<string, unknown>>;

    expect(out.headers.authorization).toBeUndefined();
    expect(out.headers.cookie).toBeUndefined();
    expect(out.headers['x-trace']).toBe('ok');
  });

  it('recurses through nested objects and arrays without mutating input', () => {
    const input = { a: [{ token: 't', n: 1 }], b: { c: { secret: 's' } } };
    const out = scrubSegiPayload(input) as any;

    expect(out.a[0].token).toBe('[Filtered]');
    expect(out.a[0].n).toBe(1);
    expect(out.b.c.secret).toBe('[Filtered]');
    // input untouched
    expect(input.a[0].token).toBe('t');
  });

  it('handles cyclic references', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    const out = scrubSegiPayload(a) as Record<string, unknown>;
    expect(out.name).toBe('x');
    expect(out.self).toBe('[Circular]');
  });
});
