// React Native (Metro) exposes a CommonJS-style `require` at runtime. Declare it so the
// guarded `require('react-native')` / rejection-tracking lookups typecheck without
// pulling in @types/node (which would wrongly widen the lib surface for an RN package).
declare const require: (moduleId: string) => any;
