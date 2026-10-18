import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FilePort } from './Tool';

/** Plain-filesystem FilePort, used in tests and as a non-VS Code fallback. */
export const nodeFilePort: FilePort = {
  readText: (abs) => fs.readFile(abs, 'utf8'),
  async writeText(abs, content) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  },
  remove: (abs) => fs.rm(abs, { force: true }),
  async exists(abs) {
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  },
};
