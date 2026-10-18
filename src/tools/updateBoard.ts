import { BoardInputError, applyBoardUpdate, describeBoard } from '../agent/board';
import { Tool, ToolInputError } from './Tool';

export const updateBoardTool: Tool = {
  name: 'update_board',
  description:
    'Your task board: a plan you keep for the work, shown to you again at the end of every turn, so use it as your memory on long tasks. ' +
    'For any task with three or more steps, first write the plan here, then keep it current: set the task you are working on to in_progress ' +
    '(ideally one at a time), and set it to done as soon as it is finished and checked. ' +
    'Send the COMPLETE task list each time (it replaces the previous list). ' +
    'Statuses: pending, in_progress, done, blocked. Use blocked, with a note, for a task you cannot continue without the user. ' +
    'Use "notes" for things you will need later: findings, decisions, file paths, the command that runs the tests. Notes replace the previous notes, so keep them short. ' +
    'You cannot finish while tasks are pending or in progress, so remove tasks that turn out to be unnecessary.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'The complete list of tasks, in order.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short description of the step.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
            note: { type: 'string', description: 'Optional: why it is blocked, or the result.' },
          },
          required: ['title', 'status'],
        },
      },
      notes: { type: 'string', description: 'Your scratch notes. Replaces the previous notes.' },
    },
  },
  requiresApproval: false,
  preview: () => ({ summary: 'Update plan' }),
  async run(input, ctx) {
    if (!ctx.board) throw new ToolInputError('The board is not available here.');
    try {
      const next = applyBoardUpdate(ctx.board.get(), input);
      ctx.board.set(next);
      return describeBoard(next);
    } catch (error) {
      if (error instanceof BoardInputError) throw new ToolInputError(error.message);
      throw error;
    }
  },
};
