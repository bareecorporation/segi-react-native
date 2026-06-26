export {
  initSegi,
  isSegiEnabled,
  logSegiStatus,
  setSegiBeforeSend,
  captureSegiException,
  captureSegiMessage,
  flushNativeCrashes,
} from './client';

export {
  isNativeCrashTrackingAvailable,
  installNativeHandlers,
  getStoredNativeCrashes,
  type NativeStoredCrash,
} from './native';

export { scrubSegiPayload } from './scrub';

export {
  installSegiGlobalHandlers,
  type InstallHandlersOptions,
} from './handlers';

export type {
  SegiConfig,
  SegiEventContext,
  SegiLevel,
  SegiUser,
  SegiBeforeSendFn,
} from './types';
