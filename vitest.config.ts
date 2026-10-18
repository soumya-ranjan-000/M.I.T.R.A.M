import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Code that needs a running VS Code (vscode API) is covered by manual testing instead.
      include: ['src/safety/**', 'src/tools/**', 'src/agent/**', 'src/providers/**', 'src/storage/sessions.ts', 'src/logging.ts', 'src/webview/protocol.ts', 'src/webview/displayReducer.ts', 'src/webview/slashCommands.ts'],
      exclude: ['src/tools/vscodeHost.ts', 'src/agent/gatherContext.ts', 'src/agent/gatherEnvironment.ts'],
      reporter: ['text'],
    },
  },
});
