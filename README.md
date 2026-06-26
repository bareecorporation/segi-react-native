# @bareecorporation/segi-react-native

Segi ([extn.ai](https://segi.extn.ai)) error-tracking SDK for **React Native**.

Segi ships official Next.js / browser SDKs but no React Native SDK. This package is a
thin, dependency-free client that talks directly to the Segi ingest endpoint, plus a
native module that captures **iOS and Android native crashes** (not just JS errors).

## What it captures

| Layer | iOS | Android |
|---|---|---|
| Uncaught JS errors (`ErrorUtils`) | ✅ | ✅ |
| Unhandled promise rejections | ✅ | ✅ |
| React render crashes (`SegiErrorBoundary`) | ✅ | ✅ |
| Native uncaught exceptions | ✅ `NSException` | ✅ JVM `Thread` handler |
| Native signals (NDK / C++) | ✅ `SIGSEGV/SIGABRT/…` | ✅ `SIGSEGV/SIGABRT/…` (NDK sigaction) |
| Manual `captureSegiException` / `captureSegiMessage` | ✅ | ✅ |

Native crashes can't be sent during the crash itself, so they are **persisted to disk
and replayed to Segi on the next app launch**.

## Install

```sh
npm install @bareecorporation/segi-react-native
# iOS
cd ios && pod install
```

Autolinking handles both platforms (RN 0.71+). No manual native registration needed.

## Quick start

```ts
// index.js — as early as possible, before rendering the app.
import {
  initSegi,
  installSegiGlobalHandlers,
} from '@bareecorporation/segi-react-native';

initSegi({
  projectKey: 'segi_pk_live_xxxxxxxxxxxxxxxx', // project key (allowedDomains: [] for native)
  environment: 'production',
  release: '1.4.2', // app version or CodePush label
  // enableNativeCrashTracking: true (default) — installs native handlers + replays prior crashes
});

installSegiGlobalHandlers(); // JS uncaught errors + unhandled promise rejections
```

### Wrap your tree with the error boundary

```tsx
import { SegiErrorBoundary } from '@bareecorporation/segi-react-native/error-boundary';

export default function App() {
  return (
    <SegiErrorBoundary fallback={(error, reset) => <Crash error={error} onRetry={reset} />}>
      <RootNavigator />
    </SegiErrorBoundary>
  );
}
```

### Capture manually

```ts
import { captureSegiException, captureSegiMessage } from '@bareecorporation/segi-react-native';

try {
  await pay();
} catch (e) {
  captureSegiException(e, {
    tags: { feature: 'checkout' },
    extra: { orderId },
    user: { id: userId },
    screen: 'CheckoutScreen',
  });
}

captureSegiMessage('coupon applied without discount', { level: 'warning' });
```

## API

| Export | Description |
|---|---|
| `initSegi(config)` | Initialise. Installs native handlers + replays prior native crashes. |
| `installSegiGlobalHandlers(opts?)` | Hook JS uncaught errors + unhandled rejections. |
| `captureSegiException(err, ctx?)` | Report an exception (fire-and-forget). |
| `captureSegiMessage(msg, ctx?)` | Report a message (default level `info`). |
| `setSegiBeforeSend(fn)` | Transform or drop (`return null`) every event before send. |
| `flushNativeCrashes()` | Manually replay persisted native crashes. Returns the count. |
| `isSegiEnabled()` / `logSegiStatus()` | Status helpers. |
| `isNativeCrashTrackingAvailable()` | Whether the native module is linked. |
| `SegiErrorBoundary` | React error boundary (`/error-boundary` entry). |

### `SegiConfig`

| Field | Default | Notes |
|---|---|---|
| `projectKey` | — | Required. Without it the SDK stays disabled. |
| `ingestUrl` | `https://segiapi.extn.ai/api/ingest/events` | Override endpoint. |
| `environment` | `production` | |
| `release` | — | App version / CodePush label. |
| `enabled` | `true` | Master kill switch. |
| `timeoutMs` | `3000` | Per-event network timeout. |
| `debug` | `false` | `console.debug` diagnostics. |
| `defaultTags` | — | Tags on every event. |
| `enableNativeCrashTracking` | `true` | Install native handlers + replay prior crashes. |

## Privacy

Every payload is recursively PII-scrubbed before send: keys matching
`password`, `*token`, `*secret`, `apiKey`, `authorization`, `cardNumber`, `rrn`,
`residentNumber` are masked to `[Filtered]`, and sensitive headers
(`authorization`, `cookie`, `x-api-key`, …) are dropped. Use `setSegiBeforeSend` for
additional redaction or to drop events entirely.

## Project key note

The key environment determines `allowedDomains`. Native apps send with no `Origin`
header, so a `production` key (unrestricted) is recommended. Server/native ingest is
not blocked by the domain allowlist regardless.

## License

MIT © Baree Corporation
