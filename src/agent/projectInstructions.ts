import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const INSTRUCTIONS_FILE = 'MITRAM.md';
const MAX_CHARS = 20_000;

export const INSTRUCTIONS_TEMPLATE = `# Project instructions for M.I.T.R.A.M

<!-- This file is added to the agent's system prompt. Keep it short and specific. -->

## Overview
What this project is and how it is laid out.

## Build and test
- Install: \`npm install\`
- Test: \`npm test\`
- Lint: \`npm run lint\`

## Conventions
- Code style, naming, patterns to follow.

## Avoid
- Things the agent should not touch or do.
`;

/** Reads MITRAM.md from the workspace root. Returns null if it is missing or empty. */
export async function loadProjectInstructions(root: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(path.join(root, INSTRUCTIONS_FILE), 'utf8')).trim();
    if (!text) return null;
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[MITRAM.md truncated]` : text;
  } catch {
    return null;
  }
}
