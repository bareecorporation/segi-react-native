// Node/vitest stub for `promise/setimmediate/rejection-tracking`. Returns no tracker so the
// SDK falls back to the DOM-style listener path, matching a non-RN environment.
export function enable(_opts: unknown): void {
  // no-op in tests
}
