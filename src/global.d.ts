// React Native (Metro) exposes a CommonJS-style `require` at runtime. Declare it so the
// guarded `require('react-native')` / rejection-tracking lookups typecheck without
// pulling in @types/node (which would wrongly widen the lib surface for an RN package).
declare const require: (moduleId: string) => any;

// Both modules are runtime/peer dependencies supplied by React Native. Keep this
// package typecheckable without installing a second React Native tree in the SDK repo.
declare module 'react-native' {
  const ReactNative: any;
  export = ReactNative;
}

declare module 'promise/setimmediate/rejection-tracking' {
  export function enable(options: {
    allRejections?: boolean;
    onUnhandled?: (id: unknown, error: unknown) => void;
    onHandled?: (id: unknown) => void;
  }): void;
}
