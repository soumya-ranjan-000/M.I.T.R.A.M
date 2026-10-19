// Typed messages exchanged between the extension host and the webview.
// This file is imported by both sides, so keep it free of vscode/node imports.

export type BoardStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface BoardTask {
  title: string;
  status: BoardStatus;
  note?: string;
}

/** The agent's working plan for a chat: a task list plus free-form notes. */
export interface Board {
  tasks: BoardTask[];
  notes: string;
}

export type ToolStatus = 'pending' | 'running' | 'ok' | 'error' | 'rejected';
export type ApprovalDecision = 'approve' | 'reject' | 'always';

/** The tool that hands a task to a sub-agent. Its card shows the sub-agent's own tool calls. */
export const SUBAGENT_TOOL = 'delegate_task';

/** Connection state of one MCP server, as shown in the MCP panel. */
export type McpStatusKind = 'idle' | 'connecting' | 'ready' | 'failed' | 'disabled';

/**
 * One MCP server, for the panel. Carries no API key: the key stays in the host's secret storage
 * and `hasKey` only says whether one has been set.
 */
export interface McpServerView {
  id: string;
  status: McpStatusKind;
  /** Why it failed, when it did. */
  error?: string;
  toolCount: number;
  /** The command or URL, so the user can tell two servers apart. */
  description: string;
  /** This server authenticates with an API key. */
  needsKey: boolean;
  /** A key has been stored for it. */
  hasKey: boolean;
  enabled: boolean;
}

/** An entry in the "Add server" picker. */
export interface McpPresetView {
  id: string;
  label: string;
  description: string;
  needsKey: boolean;
}

/** Images per message. */
export const MAX_IMAGES = 5;
/** Largest image we send, before base64 (5 MB once encoded, the API's limit per image). */
export const MAX_IMAGE_BYTES = 3_750_000;
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** An image attached to a message, already resized by the webview. */
export interface ImageAttachment {
  id: string;
  mediaType: ImageMediaType;
  /** Base64 with no "data:" prefix. Empty for an old image that was not kept when the chat was saved. */
  data: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
}

/** Other files per message: PDFs, documents, spreadsheets, text. */
export const MAX_FILES = 5;
/** Largest PDF we send. PDFs go to the model as they are, and a whole request is capped at 32 MB. */
export const MAX_PDF_BYTES = 15_000_000;
/** Text kept from one document, spreadsheet or text file (about 55k tokens). */
export const MAX_FILE_TEXT_CHARS = 200_000;
/** Base64 of the images and PDFs in one message, well inside the API's request limit. */
export const MAX_MESSAGE_ATTACHMENT_CHARS = 24_000_000;
/** Largest file the host will read to attach. */
export const MAX_UPLOAD_BYTES = 50_000_000;

/**
 * A file attached to a message. A PDF goes to the model as a document; anything else (Word, Excel,
 * PowerPoint, OpenDocument, text) as the text read from it.
 */
export interface FileAttachment {
  id: string;
  name: string;
  kind: 'pdf' | 'text';
  /** Base64 for a PDF, the text otherwise. Empty in the transcript, which keeps only the details. */
  data: string;
  /** Size of the original file. */
  bytes: number;
  /** For the chip, e.g. "12 pages" or "3 sheets · 1,204 rows". */
  detail: string;
  /** The text was cut at MAX_FILE_TEXT_CHARS. */
  truncated: boolean;
}

/** An image file the host read for the webview, before it is resized. */
export interface RawImage {
  name: string;
  mediaType: ImageMediaType;
  data: string;
}

/** A file the pre-analysis search attached to a message, and the lines it pointed at. */
export interface RetrievedRef {
  path: string;
  startLine: number;
  endLine: number;
}

/** One tool call: the agent's own, or one a sub-agent made. */
export interface ToolCall {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  status: ToolStatus;
  output?: string;
  /**
   * For a command awaiting approval: the rule "Always allow" would save, e.g. "npm test *".
   * `usesShell` means the command has pipes, chaining and so on, so only this exact text is saved.
   */
  allowRule?: { label: string; usesShell: boolean };
  /** A short label shown next to the summary, e.g. "read-only" on a sub-agent or "MCP". */
  badge?: string;
}

export type DisplayMessage =
  | { role: 'user'; text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
  /** Files the extension's own search attached to the message above, before the model ran. */
  | { role: 'retrieved'; files: RetrievedRef[] }
  | { role: 'assistant'; text: string }
  | { role: 'thinking'; text: string }
  | ({ role: 'tool' } & ToolCall & {
      /** For a sub-agent: what it is waiting for, when that is not one of its own calls. */
      note?: string;
      /** For a sub-agent: the tool calls it has made, in order. */
      steps?: ToolCall[];
    });

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'sendMessage';
      text: string;
      includeActive: boolean;
      mentions: string[];
      plan: boolean;
      images: ImageAttachment[];
      files: FileAttachment[];
    }
  | { type: 'retry' }
  | { type: 'stop' }
  | { type: 'openSettings' }
  | { type: 'setApiKey' }
  | { type: 'newChat' }
  | { type: 'switchSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'insertCode'; code: string }
  | { type: 'copyCode'; code: string }
  | { type: 'searchFiles'; query: string }
  | { type: 'approval'; id: string; decision: ApprovalDecision }
  | { type: 'viewDiff'; id: string }
  | { type: 'openFile'; path: string; line: number }
  | { type: 'revert' }
  | { type: 'pickModel' }
  | { type: 'clearBoard' }
  | { type: 'continueRun' }
  | { type: 'managePermissions' }
  | { type: 'pickFiles' }
  /** Open the MCP panel: the host replies with an `mcpStatus`. */
  | { type: 'mcpRefresh' }
  /** Start the "Add MCP server" wizard, which runs entirely in the host. */
  | { type: 'mcpAdd' }
  | { type: 'mcpRemove'; id: string }
  | { type: 'mcpEnable'; id: string; enabled: boolean }
  /** Ask the host to prompt for this server's API key. The key never passes through the webview. */
  | { type: 'mcpSetKey'; id: string }
  | { type: 'mcpRestart'; id?: string }
  /** file:// URIs copied or dragged from a file manager, for the host to read. */
  | { type: 'readFiles'; uris: string[] }
  /** A file dropped or pasted into the webview that is not an image: the host works out what it is. */
  | { type: 'attachFileData'; name: string; data: string };

export type HostToWebview =
  | { type: 'streamDelta'; text: string }
  | { type: 'thinkingDelta'; text: string }
  | { type: 'streamEnd' }
  /** `parentId` is set for a sub-agent's call: the id of the delegate_task call that started it. */
  | { type: 'toolStart'; id: string; name: string; summary: string; detail?: string; status: ToolStatus; badge?: string; parentId?: string }
  | { type: 'toolUpdate'; id: string; status: ToolStatus; output?: string; parentId?: string }
  | { type: 'toolAllowRule'; id: string; label: string; usesShell: boolean; parentId?: string }
  /** Sets or clears (empty text) a sub-agent card's note. */
  | { type: 'toolNote'; id: string; note: string }
  | { type: 'notice'; text: string }
  | { type: 'retrieved'; files: RetrievedRef[] }
  | { type: 'checkpoint'; files: string[] }
  | { type: 'modelInfo'; model: string }
  | { type: 'board'; board: Board }
  | { type: 'budgetReached'; reason: 'steps' | 'time' | 'stuck'; steps: number }
  /** A run is still going for this chat: sent when the view is opened again, which resets it. */
  | { type: 'runInProgress'; since: number; plan: boolean }
  | {
      type: 'usage';
      /** Tokens in the prompt of the latest request (uncached + cache reads + cache writes). */
      contextTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      contextWindow: number;
    }
  | { type: 'error'; message: string; needsSetup?: boolean }
  | { type: 'contextInfo'; file: string | null; hasSelection: boolean; hasWorkspace: boolean }
  | { type: 'fileResults'; query: string; files: string[] }
  /** Files the host read: images still to be resized by the webview, and files ready to attach. */
  | { type: 'attachmentsPicked'; images: RawImage[]; files: FileAttachment[] }
  | { type: 'sessions'; list: SessionSummary[]; activeId: string | null }
  /** The configured MCP servers and their connection state, for the MCP panel. */
  | { type: 'mcpStatus'; servers: McpServerView[]; presets: McpPresetView[]; problems: string[] }
  | { type: 'loadMessages'; messages: DisplayMessage[] };

const NO_PAYLOAD = new Set([
  'ready',
  'retry',
  'stop',
  'openSettings',
  'setApiKey',
  'newChat',
  'revert',
  'pickModel',
  'clearBoard',
  'continueRun',
  'managePermissions',
  'pickFiles',
  'mcpRefresh',
  'mcpAdd',
]);
const STRING_FIELD: Record<string, string> = {
  switchSession: 'id',
  deleteSession: 'id',
  insertCode: 'code',
  copyCode: 'code',
  searchFiles: 'query',
  viewDiff: 'id',
  mcpRemove: 'id',
  mcpSetKey: 'id',
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded size of base64 data. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

// The webview is the other side of a trust boundary, so attachments get a real check, not a cast.
function isImage(value: unknown): value is ImageAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const i = value as Record<string, unknown>;
  return (
    typeof i.id === 'string' &&
    typeof i.name === 'string' &&
    IMAGE_MEDIA_TYPES.includes(i.mediaType as ImageMediaType) &&
    typeof i.data === 'string' &&
    i.data.length > 0 &&
    i.data.length % 4 === 0 &&
    BASE64.test(i.data) &&
    base64Bytes(i.data) <= MAX_IMAGE_BYTES &&
    Number.isFinite(i.width) &&
    Number.isFinite(i.height) &&
    Number.isFinite(i.bytes)
  );
}

function isFile(value: unknown): value is FileAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.id !== 'string' || typeof f.name !== 'string' || typeof f.detail !== 'string') return false;
  if (typeof f.truncated !== 'boolean' || !Number.isFinite(f.bytes) || typeof f.data !== 'string' || !f.data) return false;
  if (f.kind === 'text') return f.data.length <= MAX_FILE_TEXT_CHARS;
  return (
    f.kind === 'pdf' &&
    f.data.startsWith('JVBERi0') && // "%PDF-"
    f.data.length % 4 === 0 &&
    BASE64.test(f.data) &&
    base64Bytes(f.data) <= MAX_PDF_BYTES
  );
}

/** Base64 characters of a message's images and PDFs. */
export function attachmentChars(images: ImageAttachment[], files: FileAttachment[]): number {
  return images.reduce((n, i) => n + i.data.length, 0) + files.reduce((n, f) => n + (f.kind === 'pdf' ? f.data.length : 0), 0);
}

export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return false;
  if (NO_PAYLOAD.has(v.type)) return true;
  if (v.type === 'sendMessage') {
    return (
      typeof v.text === 'string' &&
      typeof v.includeActive === 'boolean' &&
      typeof v.plan === 'boolean' &&
      Array.isArray(v.mentions) &&
      v.mentions.every((m) => typeof m === 'string') &&
      Array.isArray(v.images) &&
      v.images.length <= MAX_IMAGES &&
      v.images.every(isImage) &&
      Array.isArray(v.files) &&
      v.files.length <= MAX_FILES &&
      v.files.every(isFile) &&
      attachmentChars(v.images, v.files) <= MAX_MESSAGE_ATTACHMENT_CHARS
    );
  }
  if (v.type === 'readFiles') {
    return Array.isArray(v.uris) && v.uris.length <= 50 && v.uris.every((u) => typeof u === 'string');
  }
  if (v.type === 'attachFileData') {
    return (
      typeof v.name === 'string' &&
      typeof v.data === 'string' &&
      v.data.length % 4 === 0 &&
      base64Bytes(v.data) <= MAX_UPLOAD_BYTES &&
      BASE64.test(v.data)
    );
  }
  if (v.type === 'openFile') {
    return typeof v.path === 'string' && v.path.length <= 1024 && Number.isInteger(v.line) && (v.line as number) >= 1;
  }
  if (v.type === 'approval') {
    return typeof v.id === 'string' && (v.decision === 'approve' || v.decision === 'reject' || v.decision === 'always');
  }
  if (v.type === 'mcpEnable') {
    return typeof v.id === 'string' && typeof v.enabled === 'boolean';
  }
  if (v.type === 'mcpRestart') {
    // No id means "reconnect everything".
    return v.id === undefined || typeof v.id === 'string';
  }
  const field = STRING_FIELD[v.type];
  return field !== undefined && typeof v[field] === 'string';
}
