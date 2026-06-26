import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureSegiException,
  captureSegiMessage,
  initSegi,
  isSegiEnabled,
  setSegiBeforeSend,
} from '../src/client';

const INGEST = 'https://segiapi.extn.ai/api/ingest/events';

function lastBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

describe('segi client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 202, ok: true });
    vi.stubGlobal('fetch', fetchMock);
    setSegiBeforeSend(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stays disabled until initialised with a projectKey', () => {
    initSegi({ projectKey: '' });
    expect(isSegiEnabled()).toBe(false);
    captureSegiException(new Error('x'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a scrubbed error event with the project key header', async () => {
    initSegi({ projectKey: 'segi_pk_live_test', environment: 'staging', release: 'v1' });
    expect(isSegiEnabled()).toBe(true);

    captureSegiException(new TypeError('boom'), {
      tags: { feature: 'pay' },
      extra: { token: 'secret-value', screenName: 'Checkout' },
      user: { id: 42, email: 'a@b.com' },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(INGEST);
    expect((init.headers as Record<string, string>)['x-segi-project-key']).toBe('segi_pk_live_test');

    const body = lastBody(fetchMock);
    expect(body.type).toBe('error');
    expect(body.errorName).toBe('TypeError');
    expect(body.message).toBe('boom');
    expect(body.platform).toBe('react-native');
    expect(body.environment).toBe('staging');
    expect(body.release).toBe('v1');
    expect(body.tags.feature).toBe('pay');
    expect(body.extra.token).toBe('[Filtered]'); // PII scrubbed
    expect(body.context.userId).toBe('42');
  });

  it('merges defaultTags under per-event tags', async () => {
    initSegi({ projectKey: 'k', defaultTags: { app: 'native', feature: 'base' } });
    captureSegiMessage('hello', { tags: { feature: 'override' }, level: 'warning' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = lastBody(fetchMock);
    expect(body.type).toBe('message');
    expect(body.level).toBe('warning');
    expect(body.tags.app).toBe('native');
    expect(body.tags.feature).toBe('override');
  });

  it('beforeSend can drop events', async () => {
    initSegi({ projectKey: 'k' });
    setSegiBeforeSend(() => null);
    captureSegiException(new Error('dropme'));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    initSegi({ projectKey: 'k' });
    expect(() => captureSegiException(new Error('x'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
