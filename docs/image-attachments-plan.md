# Image attachments in the chat composer

> **Status: implemented.** Where the build differs from this plan:
>
> - **Resize limit.** Images are scaled to 2576 px on the long edge and 3.75 MP, not 1568 px. Opus 4.7 and later
>   (including the default `claude-opus-5-5`) read that resolution, at up to ~4784 tokens per image. Every image
>   is re-encoded, not only large ones, which also strips metadata such as GPS location.
> - **Paste.** `preventDefault()` is called synchronously; the plan's version called it after an `await`, too late
>   to stop the default paste. A paste that also carries `text/plain` (spreadsheet cells) stays a text paste.
> - **Host picker.** The host sends the raw file bytes to the webview, which resizes them exactly like a paste,
>   so large files are scaled down instead of refused. File types come from magic bytes, not extensions.
> - **Token estimate.** Dimensions are read from the PNG/JPEG header (`src/agent/images.ts`), capped at 4784 tokens.
> - **Request size.** Not in the plan: `pruneImages` keeps the history at 20 images and 24 MB of base64 at most, so a
>   long chat full of screenshots cannot outgrow the API's request limit.
> - **Image-only messages** get the text "(see the attached image)": the API rejects empty text blocks, and the
>   context manager needs a text block to recognise a typed turn.
> - **Persistence.** On disk, image data is kept for the last 2 messages with images, in the 3 most recent chats
>   only (the per-chat rule alone still allowed ~50 chats' worth), and for the model history as well as the transcript.

Paste a screenshot with **Ctrl+V**, or add images with a **+** button. Up to **5 images** per
message. Images are sent to the model as `image` content blocks.

## The user-visible flow

1. User takes a screenshot (Flameshot / PrintScreen / Snipping Tool → clipboard).
2. Clicks the chat box, presses **Ctrl+V**.
3. A thumbnail chip appears in the `.attachments` row above the textarea:
   *image · 1824×968 · 240 KB · ×*.
4. The textarea keeps whatever text was typed; the cursor stays put. Pasting plain text behaves
   exactly as it does today.
5. The **+** button next to `@` opens the same thing via a file dialog.
6. At 5 images, the 6th paste is refused with an inline hint: "Up to 5 images per message."
7. Send → images go to the model as `image` blocks; the chips clear; the sent message shows the
   thumbnails in the transcript.

---

## 1. Shared types — `src/webview/protocol.ts`

```ts
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 3_750_000;   // Anthropic's per-image cap
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface ImageAttachment {
  id: string;
  mediaType: ImageMediaType;
  data: string;        // base64, no "data:" prefix
  name: string;        // "screenshot.png"
  width: number;
  height: number;
  bytes: number;
}
```

- `sendMessage` gains `images: ImageAttachment[]`.
- New `WebviewToHost`: `{ type: 'pickImages' }`.
- New `HostToWebview`: `{ type: 'imagesPicked'; images: ImageAttachment[] }`.
- `DisplayMessage` user variant: `{ role: 'user'; text: string; images?: ImageAttachment[] }`.

**Validation in `isWebviewToHost`** — this is the trust boundary, so it gets a real check, not a
cast:

```ts
function isImage(v: unknown): v is ImageAttachment {
  const i = v as Record<string, unknown>;
  return !!i && typeof i.id === 'string'
    && IMAGE_MEDIA_TYPES.includes(i.mediaType as ImageMediaType)
    && typeof i.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(i.data)
    && typeof i.bytes === 'number' && i.bytes > 0 && i.bytes <= MAX_IMAGE_BYTES
    && typeof i.width === 'number' && typeof i.height === 'number'
    && typeof i.name === 'string';
}
```

In the `sendMessage` branch:
`Array.isArray(v.images) && v.images.length <= MAX_IMAGES && v.images.every(isImage)`.

## 2. Paste handling — `webview-ui/src/components/Composer.tsx`

New `webview-ui/src/images.ts`:

```ts
export async function fromClipboard(items: DataTransferItemList): Promise<File[]>
export async function toAttachment(file: File): Promise<ImageAttachment>
```

`toAttachment` does the work screenshots need: `createImageBitmap(file)` → if the long edge is over
1568px (Anthropic downscales past this anyway) draw to a `<canvas>` and re-encode →
`canvas.toBlob('image/png')`, falling back to `image/jpeg` q0.85 if the PNG still exceeds
`MAX_IMAGE_BYTES` → `FileReader` → strip the `data:...;base64,` prefix.

A 4K screenshot (3840×2160, ~2 MB PNG) becomes 1568×882, ~400 KB — and drops from ~11k to ~1.8k
tokens. Worth doing.

In the Composer:

```tsx
async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
  const files = await fromClipboard(e.clipboardData.items);
  if (files.length === 0) return;      // plain text paste: untouched
  e.preventDefault();
  addImages(files);
}
```

`addImages` enforces the cap *before* decoding (`MAX_IMAGES - images.length` slots), sets `hint`
state for refusals, and appends to `const [images, setImages] = useState<ImageAttachment[]>([])`.

Also wire `onDrop` / `onDragOver` on `.composer-card` to the same `addImages` — about 8 extra lines,
and people will try it.

`send()` already clears `text` / `mentions`; add `setImages([])`, and block send only when
`!text.trim() && images.length === 0` (an image alone should be sendable).

## 3. The **+** button

`composer-bar` currently starts with the `@` button. Put **+** first, as a small menu (reuse the
`.mentions` list styling, close on blur/Escape):

- *Attach image…* → `postToHost({ type: 'pickImages' })`
- *Attach file…* → existing `startMention()`

The `plus` icon already exists in `Icon.tsx`; add an `image` glyph
(`<rect x=3 y=3 width=18 height=18 rx=2/><circle cx=9 cy=9 r=2/><path d="m21 15-5-5L5 21"/>`).

The host's `imagesPicked` reply is handled in the Composer's existing `onHostMessage` effect, right
next to `fileResults`.

## 4. Chips + transcript

- New `webview-ui/src/components/Attachments.tsx` — renders into the existing `.attachments` row
  (shares it with the active-file pill). `<img src={`data:${mediaType};base64,${data}`} />`.
  **No CSP change needed**: `getHtml` already sets `img-src ${webview.cspSource} data:`.
- Each chip: 44px thumbnail, name, `Math.round(bytes / 1024) KB`, `×` remove button, `title` with
  dimensions.
- `App.tsx`: render `m.images` under the user `.bubble` (small thumbnail row) and thread `images`
  through `send()`.
- `styles.css`:
  `.attachment-thumb { width:44px; height:44px; object-fit:cover; border-radius:4px; border:1px solid var(--vscode-widget-border); }`.

## 5. Host side — `src/webview/ChatViewProvider.ts`

- `case 'pickImages'` → `showOpenDialog({ canSelectMany: true, filters: { Images: ['png','jpg','jpeg','gif','webp'] } })`
  → `vscode.workspace.fs.readFile` → base64 → `imagesPicked`. Cap at `MAX_IMAGES`, warn via
  `showWarningMessage` for files over `MAX_IMAGE_BYTES` (there is no canvas in the host, so these
  are rejected rather than resized — dimensions come from a tiny PNG/JPEG header parse, or `0` with
  a flat token estimate).
- `Run` gains `images: ImageAttachment[]` so **Retry** resends them.
- `run()`: `session.display.push({ role: 'user', text: run.text, images: run.images })`.

## 6. Model message — `src/agent/ContextBuilder.ts`

```ts
export function buildUserContent(text, parts, environment, images): string | ContentBlockParam[]
```

Returns the **existing string** when `images.length === 0` — that keeps every current test green and
the prompt-cache prefix byte-identical. Otherwise: image blocks first, then one text block with the
`formatUserMessage(...)` output.

## 7. Token accounting — `src/agent/contextManager.ts` ⚠️

The real trap. `blockChars`'s `default` branch is `JSON.stringify(block).length`, so one base64
screenshot counts as ~400k tokens and instantly triggers trimming of the whole conversation.

- Add `case 'image':` → `Math.ceil((width * height) / 750) * CHARS_PER_TOKEN`, with a flat
  ~1600-token fallback when dimensions are unknown. (Anthropic's formula is `w * h / 750`.) This
  needs `width`/`height` carried on the block or in a side table — simplest is a `_meta` field
  stripped before sending, or recomputing from the base64 header.
- In `clearBulky`, strip `image` blocks from turns older than the current one, replacing them with
  `[image removed to save context]` — five screenshots per turn adds up fast.

## 8. Persistence

5 images × ~400 KB × 50 sessions is ~100 MB in `sessions.json`. For v1: keep base64 only for the
**last 2 turns** when saving; older ones persist `{ ...meta, data: '' }` and the transcript shows a
greyed "image (not kept)" chip. The model history is unaffected within a live session. If it becomes
a problem, v2 writes files to `globalStorageUri/images/<sessionId>/` and rehydrates them on send.

## 9. Tests

- `test/protocol.test.ts` — valid images accepted; bad mediaType, non-base64 `data`, 6 images and an
  oversized image all rejected.
- `test/context.test.ts` — `buildUserContent` returns a plain string with no images (regression),
  and the correct block order with them.
- `test/contextManager.test.ts` — an image block is estimated near `w * h / 750`, not megabytes, and
  is stripped by `clearBulky`.
- `test/displayReducer.test.ts` — a user message with images round-trips.
- Verify with: `npm test`, `npm run typecheck`, `npm run build`, then F5 and paste a real
  screenshot.

## Linux caveat

On some Wayland/X11 setups, copying an image file *from a file manager* puts only `text/uri-list` on
the clipboard. Screenshot tools (Flameshot, GNOME Screenshot, Spectacle) put real image bytes, so
the screenshot flow works. Add a `text/uri-list` fallback that forwards the paths to the host to
read, which covers the file-manager case too.

---

## Build order

1. Steps **1 → 2 → 4**: paste working end-to-end in the UI.
2. Steps **6 → 7**: images actually reaching the model, with sane token accounting.
3. Steps **3, 5**: the + button and the host file picker.
4. Steps **8, 9**: persistence trimming and tests.
