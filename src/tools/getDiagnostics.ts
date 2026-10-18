import { Tool, optString } from './Tool';

export const getDiagnosticsTool: Tool = {
  name: 'get_diagnostics',
  description:
    'Get the errors and warnings the editor currently reports (type errors, lint problems). ' +
    'Use it after editing code to check your changes. Optionally limit to one file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path. Omit for all files.' },
    },
  },
  requiresApproval: false,
  preview: (input) => ({ summary: `Diagnostics ${(input as { path?: string })?.path || '(all files)'}` }),
  async run(input, ctx) {
    if (!ctx.diagnostics) return 'Diagnostics are not available in this environment.';
    return ctx.diagnostics(optString(input, 'path'));
  },
};
