export {
  initSegi,
  isSegiEnabled,
  logSegiStatus,
  setSegiBeforeSend,
  captureSegiException,
  captureSegiMessage,
  flushNativeCrashes,
  flushSegiRetryQueue,
  addSegiBreadcrumb,
} from './client';

export {
  // global scope
  setSegiUser,
  getSegiUser,
  setSegiTag,
  setSegiTags,
  setSegiExtra,
  setSegiExtras,
  setSegiContext,
  configureSegiScope,
  clearSegiScope,
  getSegiScope,
  // breadcrumbs
  setSegiMaxBreadcrumbs,
  setSegiBeforeBreadcrumb,
  addSegiNavigationBreadcrumb,
  getSegiBreadcrumbs,
  clearSegiBreadcrumbs,
  type SegiScopeSnapshot,
} from './scope';

export { buildSegiContexts } from './context';

export {
  isNativeCrashTrackingAvailable,
  installNativeHandlers,
  getStoredNativeCrashes,
  startAppHangWatchdog,
  stopAppHangWatchdog,
  type NativeStoredCrash,
} from './native';

export { scrubSegiPayload } from './scrub';

export {
  installSegiGlobalHandlers,
  type InstallHandlersOptions,
} from './handlers';

export type {
  SegiConfig,
  SegiAutoBreadcrumbOptions,
  SegiEventContext,
  SegiLevel,
  SegiUser,
  SegiBreadcrumb,
  SegiContexts,
  SegiBeforeSendFn,
  SegiBeforeBreadcrumbFn,
} from './types';
