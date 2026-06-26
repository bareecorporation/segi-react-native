// Device / OS / app context enrichment (Sentry parity), gathered from React Native
// core only — no native module and no extra dependencies. `react-native` is resolved
// defensively so the JS-only API keeps working when RN is absent.
import type { SegiContexts } from './types';
import { getRN } from './rn';

interface RNLike {
  Platform?: {
    OS?: string;
    Version?: string | number;
    constants?: Record<string, unknown>;
    isTesting?: boolean;
  };
  Dimensions?: { get?: (dim: string) => { width: number; height: number; scale?: number; fontScale?: number } };
  NativeModules?: Record<string, unknown>;
};

function rn(): RNLike | null {
  return getRN() as RNLike | null;
}

function detectRuntime(): string {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.HermesInternal !== 'undefined' && g.HermesInternal !== null) return 'hermes';
  return 'jsc';
}

let _cached: SegiContexts | null = null;

/**
 * Build the `contexts` object (device / os / app / runtime). Cached after first build
 * since most fields are static for the process. `sendDefaultPii` gates locale/timezone
 * and the device name, which can be mildly identifying.
 */
export function buildSegiContexts(sendDefaultPii: boolean): SegiContexts {
  if (_cached) return applyPii(_cached, sendDefaultPii);

  const contexts: SegiContexts = {};
  const r = rn();
  const P = r?.Platform;
  const constants = (P?.constants ?? {}) as Record<string, unknown>;

  // --- os ---
  const os: Record<string, unknown> = {};
  if (P?.OS) os.name = P.OS === 'ios' ? 'iOS' : P.OS === 'android' ? 'Android' : P.OS;
  if (P?.Version != null) os.version = String(P.Version);
  if (typeof constants.systemName === 'string') os.name = constants.systemName;
  if (typeof constants.osVersion === 'string') os.version = constants.osVersion;
  if (typeof constants.Release === 'string') os.version = constants.Release; // Android
  if (Object.keys(os).length) contexts.os = os;

  // --- device ---
  const device: Record<string, unknown> = {};
  // Android exposes Brand/Model/Manufacturer/Fingerprint in Platform.constants.
  if (typeof constants.Brand === 'string') device.brand = constants.Brand;
  if (typeof constants.Model === 'string') device.model = constants.Model;
  if (typeof constants.Manufacturer === 'string') device.manufacturer = constants.Manufacturer;
  if (typeof constants.uiMode === 'string') device.ui_mode = constants.uiMode;
  if (P?.OS === 'ios') device.family = 'iOS';
  try {
    const win = r?.Dimensions?.get?.('window');
    const screen = r?.Dimensions?.get?.('screen');
    const s = screen ?? win;
    if (s) {
      device.screen_width_pixels = Math.round((s.width ?? 0) * (s.scale ?? 1));
      device.screen_height_pixels = Math.round((s.height ?? 0) * (s.scale ?? 1));
      if (s.scale != null) device.screen_density = s.scale;
    }
  } catch {
    // Dimensions unavailable — skip
  }
  device.simulator = isSimulator(constants, P?.OS);
  if (Object.keys(device).length) contexts.device = device;

  // --- runtime ---
  contexts.runtime = {
    name: detectRuntime(),
    // RN version when exposed (Android constants.reactNativeVersion, else unknown).
    ...(constants.reactNativeVersion
      ? { react_native: stringifyRnVersion(constants.reactNativeVersion) }
      : {}),
  };

  // --- app ---
  const app: Record<string, unknown> = {};
  if (typeof constants.appOwnership === 'string') app.app_ownership = constants.appOwnership;
  if (Object.keys(app).length) contexts.app = app;

  _cached = contexts;
  return applyPii(contexts, sendDefaultPii);
}

function isSimulator(constants: Record<string, unknown>, os?: string): boolean {
  if (os === 'ios') {
    const ui = constants.interfaceIdiom;
    // iOS simulators report isTesting/forceTouchAvailable differently; the most
    // reliable core signal is the absence of a real model identifier.
    return constants.isTesting === true || /simulator/i.test(String(constants.systemName ?? ''));
  }
  if (os === 'android') {
    const fp = String(constants.Fingerprint ?? '');
    return /generic|emulator|sdk_gphone|vbox/i.test(fp) || /sdk/i.test(String(constants.Model ?? ''));
  }
  return false;
}

function stringifyRnVersion(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.major != null) return `${o.major}.${o.minor ?? 0}.${o.patch ?? 0}`;
  }
  return String(v);
}

function applyPii(contexts: SegiContexts, sendDefaultPii: boolean): SegiContexts {
  if (sendDefaultPii) return contexts;
  // Strip mildly-identifying fields when PII is not opted in. (We never collect
  // device name / locale / timezone in the first place, so this is a no-op guard
  // kept for forward-compat as fields are added.)
  return contexts;
}
