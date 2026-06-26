import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureSegiException,
  captureSegiMessage,
  initSegi,
  flushSegiRetryQueue,
  addSegiBreadcrumb,
} from '../src/client';
import {
  setSegiUser,
  setSegiTag,
  setSegiExtra,
  setSegiContext,
  clearSegiScope,
  getSegiBreadcrumbs,
} from '../src/scope';

function lastBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

describe('segi parity features', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 202, ok: true });
    vi.stubGlobal('fetch', fetchMock);
    clearSegiScope();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('merges global scope user/tags/extras into events', async () => {
    initSegi({ projectKey: 'k' });
    setSegiUser({ id: 7, email: 'u@x.com' });
    setSegiTag('plan', 'pro');
    setSegiExtra('orderId', 'A1');
    setSegiContext('order', { id: 'A1', total: 1000 });

    captureSegiException(new Error('scoped'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = lastBody(fetchMock);
    expect(body.user.id).toBe('7');
    expect(body.user.email).toBe('u@x.com');
    expect(body.tags.plan).toBe('pro');
    expect(body.extra.orderId).toBe('A1');
    expect(body.contexts.order.id).toBe('A1');
    expect(body.sdk.name).toBe('@bareecorporation/segi-react-native');
  });

  it('attaches breadcrumbs to events', async () => {
    initSegi({ projectKey: 'k' });
    addSegiBreadcrumb({ category: 'auth', message: 'logged in' });
    addSegiBreadcrumb({ category: 'nav', message: 'Home' });
    expect(getSegiBreadcrumbs()).toHaveLength(2);

    captureSegiMessage('with crumbs', { level: 'info' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = lastBody(fetchMock);
    expect(Array.isArray(body.breadcrumbs)).toBe(true);
    expect(body.breadcrumbs.at(-1).message).toBe('Home');
    expect(body.breadcrumbs[0].timestamp).toBeTruthy();
  });

  it('caps breadcrumbs at maxBreadcrumbs', async () => {
    initSegi({ projectKey: 'k', maxBreadcrumbs: 3 });
    for (let i = 0; i < 10; i++) addSegiBreadcrumb({ message: `b${i}` });
    const crumbs = getSegiBreadcrumbs();
    expect(crumbs).toHaveLength(3);
    expect(crumbs.map((c) => c.message)).toEqual(['b7', 'b8', 'b9']);
  });

  it('dedupes identical consecutive events within the window', async () => {
    initSegi({ projectKey: 'k', dedupeWindowMs: 5000 });
    const err = new Error('same'); // same instance → identical stack/fingerprint
    captureSegiException(err);
    captureSegiException(err);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sampleRate=0 drops non-fatal but fatal crashes bypass sampling', async () => {
    initSegi({ projectKey: 'k', sampleRate: 0, dedupeWindowMs: 0 });
    captureSegiException(new Error('sampled-out'), { level: 'error' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();

    captureSegiException(new Error('fatal-crash'), { level: 'fatal', handled: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastBody(fetchMock).level).toBe('fatal');
  });

  it('queues failed events and flushes them on retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    initSegi({ projectKey: 'k', dedupeWindowMs: 0 });
    captureSegiException(new Error('will-queue'));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1); // failed

    fetchMock.mockResolvedValue({ status: 202, ok: true });
    const flushed = await flushSegiRetryQueue();
    expect(flushed).toBe(1);
  });
});
