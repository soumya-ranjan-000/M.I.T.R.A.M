import type { McpManager } from '../mcp/McpManager';
import { createFileTool, editFileTool } from './editFile';
import { getDiagnosticsTool } from './getDiagnostics';
import { listDirTool } from './listDir';
import { readFileTool } from './readFile';
import { runCommandTool } from './runCommand';
import { findFilesTool, searchFilesTool } from './searchFiles';
import { ToolRegistry } from './Tool';
import { updateBoardTool } from './updateBoard';

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(listDirTool)
    .register(searchFilesTool)
    .register(findFilesTool)
    .register(getDiagnosticsTool)
    .register(updateBoardTool)
    .register(editFileTool)
    .register(createFileTool)
    .register(runCommandTool);
}

/**
 * The built-in tools plus the tools of every connected MCP server.
 *
 * Connecting is lazy and happens here, on the first run that needs tools. A server that fails to
 * start contributes nothing and never stops the run, so with no servers configured — or with all
 * of them broken — this behaves exactly like `createDefaultRegistry()`.
 */
export async function createRegistry(mcp?: McpManager): Promise<ToolRegistry> {
  const registry = createDefaultRegistry();
  if (!mcp?.configured) return registry;

  await mcp.ensureStarted();
  for (const tool of mcp.tools()) registry.register(tool);
  return registry;
}
