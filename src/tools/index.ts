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
