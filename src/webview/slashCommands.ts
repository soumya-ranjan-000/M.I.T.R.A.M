// Slash commands typed in the composer. Pure, so both the webview and the tests can use it.

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', aliases: ['clear'], description: 'Start a new chat' },
  { name: 'undo', description: 'Revert the file changes from the last turn' },
  { name: 'plan', description: 'Toggle plan mode: investigate and propose a plan before changing anything' },
  { name: 'model', description: 'Choose the model' },
];

const names = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])];

/** Commands whose name starts with what has been typed so far, for the autocomplete list. */
export function suggestSlash(text: string): SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  return SLASH_COMMANDS.filter((c) => names(c).some((n) => n.startsWith(prefix)));
}

/** The command a message consists of, if it is exactly "/name" (optionally with trailing spaces). */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/([a-z]+)\s*$/i.exec(text.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  return SLASH_COMMANDS.find((c) => names(c).includes(word)) ?? null;
}
