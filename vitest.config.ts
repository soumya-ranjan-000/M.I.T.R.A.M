import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Code that needs a running VS Code (vscode API) is covered by manual testing instead.
      include: ['src/safety/**', 'src/tools/**', 'src/agent/**', 'src/providers/**', 'src/mcp/**', 'src/storage/sessions.ts', 'src/logging.ts', 'src/webview/protocol.ts', 'src/webview/displayReducer.ts', 'src/webview/slashCommands.ts'],
      // McpConfigStore reads and writes VS Code settings, so it is covered by manual testing.
      exclude: ['src/tools/vscodeHost.ts', 'src/agent/gatherContext.ts', 'src/agent/gatherEnvironment.ts', 'src/mcp/McpConfigStore.ts'],
      reporter: ['text'],
    },
  },
});
