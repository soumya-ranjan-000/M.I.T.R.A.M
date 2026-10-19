import { SUBAGENT_TOOL } from '../webview/protocol';
import { SubagentMode, Tool, ToolInputError, optString, reqString } from './Tool';

const MODES: SubagentMode[] = ['explore', 'implement'];

const BADGES: Record<SubagentMode, string> = { explore: 'read-only', implement: 'can edit' };

function readMode(input: unknown): SubagentMode {
  const mode = optString(input, 'mode') ?? 'explore';
  if (!MODES.includes(mode as SubagentMode)) throw new ToolInputError('"mode" must be "explore" or "implement".');
  return mode as SubagentMode;
}

/**
 * Hands a task to a sub-agent. `canImplement` is false in plan mode, where sub-agents may only
 * read, so the model is never offered a mode it cannot use.
 */
export function createDelegateTaskTool({ canImplement }: { canImplement: boolean }): Tool {
  const modes = canImplement ? MODES : (['explore'] as SubagentMode[]);
  return {
    name: SUBAGENT_TOOL,
    description:
      'Hand a self-contained task to a sub-agent, which works on it with its own context and tools and returns a final report. ' +
      'Only the report comes back to you, not the files it read or the commands it ran, so delegating keeps your context small. ' +
      'To run several tasks in parallel, call this tool several times in the same response; a few run at once and the rest wait their turn. ' +
      'The sub-agent knows nothing about this conversation: put everything it needs in "prompt" (the goal, relevant files and facts you already know, constraints, and exactly what to report back). ' +
      'Good uses: investigating several independent questions or parts of the codebase at once; a broad search where you only need the conclusion' +
      (canImplement ? '; independent changes to separate files or modules (mode "implement").' : '.') +
      ' Do not delegate a single quick lookup (do it yourself), steps that depend on each other (run them one after another)' +
      (canImplement ? ', or changes to the same file from two sub-agents at once.' : '.') +
      ' Reports can be wrong or incomplete: check the claims that matter.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short label for the task, 3 to 6 words, shown to the user. E.g. "Map the auth flow".' },
        prompt: {
          type: 'string',
          description: 'The complete brief for the sub-agent: the goal, the context it needs, constraints, and what its report should contain.',
        },
        mode: {
          type: 'string',
          enum: modes,
          description: canImplement
            ? '"explore" (default): read-only tools, to investigate and report. "implement": can also edit files and run commands, under the user\'s approval settings.'
            : 'Only "explore" (read-only) is available in plan mode.',
        },
      },
      required: ['description', 'prompt'],
    },
    requiresApproval: false,
    preview(input) {
      const i = input as { description?: unknown; prompt?: unknown; mode?: unknown };
      const mode = i.mode === 'implement' && canImplement ? 'implement' : 'explore';
      return {
        summary: typeof i.description === 'string' && i.description.trim() ? i.description.trim() : 'Sub-agent',
        detail: typeof i.prompt === 'string' ? i.prompt : undefined,
        badge: BADGES[mode],
      };
    },
    async run(input, ctx) {
      const description = reqString(input, 'description').trim();
      const prompt = reqString(input, 'prompt').trim();
      const mode = readMode(input);
      if (!prompt) throw new ToolInputError('"prompt" must not be empty: give the sub-agent a complete brief.');
      if (mode === 'implement' && !canImplement) {
        throw new ToolInputError('Plan mode is on, so sub-agents can only explore. Use mode "explore".');
      }
      if (!ctx.subagents || !ctx.callId) throw new ToolInputError('Sub-agents are not available here. Do the task yourself.');
      return ctx.subagents.run({ callId: ctx.callId, description: description || 'Sub-agent', prompt, mode }, ctx);
    },
  };
}
