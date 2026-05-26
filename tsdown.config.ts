import { defineConfig } from 'tsdown'

export default defineConfig({
    entry: [
        'src/index.ts',
        'src/activity.ts',
        'src/client.ts',
        'src/common.ts',
        'src/operations.ts',
        'src/worker.ts',
        'src/testing.ts',
        // Loaded at runtime by services/worker.ts via path.resolve, not as a static import,
        // so tsdown won't pick it up unless it's an explicit entry.
        'src/interceptors/traceLogAttributes.ts',
        // CLI entry: referenced by package.json#bin as dist/cli/index.js. Without this entry
        // the tarball ships no cli/ directory, the bin symlink fails to create, and any
        // service script that calls ./node_modules/.bin/diia-workflow errors with "not found".
        'src/cli/index.ts',
    ],
    format: 'esm',
    dts: true,
    unbundle: true,
    outDir: 'dist',
    target: 'es2022',
    clean: true,
    fixedExtension: false,
    report: false,
    deps: { skipNodeModulesBundle: true },
})
