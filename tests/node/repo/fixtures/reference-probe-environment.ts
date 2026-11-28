/** Resource/ordering probes verify native evidence rather than nested coverage. */
export function referenceProbeEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    // Node restores a missing key from its own environment in spawn(). An
    // explicit empty value prevents that automatic coverage propagation.
    return { ...process.env, ...overrides, NODE_V8_COVERAGE: '' };
}
