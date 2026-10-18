# Code retrieval before analysis

> **Status:**
>
> - **Step 1 is done.** The current path was analysed and a baseline was measured.
> - **Step 2 is done.** A deterministic pre-analysis pass now attaches likely-relevant code to each message.
>   It met the bar set in step 1 on the first held-out round.
> - **Round 2 is done.** The ranking was fixed, and a card now shows what was attached.
> - **An independent check found a weakness.** On requests written by a separate agent, the pass is no better
>   than one well-chosen search term, and misses the step 1 bar. See "What the independent round shows".
>
> ```
> npm run bench:retrieval [-- --runs N] [--large <dir>] [--save-baseline]
> ```
>
> The benchmark calls no model and finishes in about 15 seconds. Its latest numbers are in
> `test/retrieval/baseline.json`.

## Round 2: fixing the shortfalls, and an independent check

### Changes

Each change was kept or rejected on the 24 tuning requests and the tuning chatter only, measured one at a
time in this order.

| change | effect on the tuning set | kept? |
| --- | --- | --- |
| **A. Test intent.** "I ran the tests" no longer turns off the test weighting; that takes "add a test", "the test fails" and similar. A test file never outranks its own code unless the message asks for test work. | none on the metrics | kept: removes a failure mode at no cost |
| **B. Word forms.** "verified" = "verify". Shorter forms (-er, -or, -ion, -ation, -ment, -able) count at 0.6 weight, so "picker" finds `pickModel`. | MRR 0.744 → 0.754, recall@10 0.861 → 0.903 | kept |
| **C. Synonyms.** 21 groups of developer vocabulary (revert/restore/undo, stop/cancel/abort, setting/config/option…) count at 0.5 weight. Each word of the message counts once, through whichever form matches best. | MRR 0.754 → 0.777, recall@10 0.903 → 0.965, attached recall 0.785 → 0.847 | kept |
| **D. Imports.** Files imported by the top 3 results get ×1.25. | MRR +0.024 but recall@10 −0.021: four requests better, four worse | rejected, code removed |
| **Gate.** Two matched words in any of the top 3 files, not only the best one. | 24 of 24 requests attached (was 23), attached recall 0.847 → 0.868, chatter unchanged | kept |

**The "related files" card.** When the pass attaches something, a collapsed "Attached N related files" card
appears under your message. Expanded, it lists each file with its line range, and clicking a file opens it at
that line. The card is saved with the chat. The webview's `openFile` request is validated, and the path is
resolved inside the workspace before anything opens.

### How the evaluation was kept honest

- **Decisions on the tuning set only.** Every keep or reject decision used the tuning set alone.
- **Round 2: not fully blind for C.** These 8 requests and 8 chatter messages were written before the fixes.
  But I wrote them, and the synonym list came after, so round 2 isn't fully blind for fix C.
- **Round 3: fully blind.** A separate agent wrote these 10 requests and 6 chatter messages, labelled against
  the pinned commit. It never saw the retrieval code, and its file was read only after every decision above was
  final.
- **Valid comparison.** The step 2 ranker was rebuilt in a scratch copy for comparison, and it reproduces step
  2's recorded numbers exactly.

### Results (attached block: MRR / share of labelled files attached)

| set | step 2 | round 2 | `search_files`, best single term (oracle) |
| --- | --- | --- | --- |
| tuning (24) | 0.74 / 0.78 | **0.77 / 0.87** | 0.42 / 0.70 |
| held out 1 (8) | 0.90 / 1.00 | **0.91 / 1.00** | 0.40 / 0.88 |
| held out 2 (8) | 0.53 / 0.75 | **0.65 / 0.94** | 0.30 / 0.75 |
| held out 3 (10, independent) | 0.40 / 0.48 | **0.45 / 0.45** | 0.40 / 0.75 |

| chatter that attached something | step 2 | round 2 |
| --- | --- | --- |
| tuning (8) | 1 | 1 |
| held out 1 (8) | 1 | 1 |
| held out 2 (8) | 3 | 3 |
| held out 3 (6) | 2 | 2 |

Across all requests, attached blocks were 243 to 978 tokens, with a median of 649. Latency is unchanged from
step 2.

### What the independent round shows

- **My own requests flattered the pass.** I wrote the tuning set and rounds 1 and 2 knowing the code's
  vocabulary. The independent requests describe cross-cutting behaviour in everyday words: "links in answers
  aren't clickable", "a second project folder is ignored", "status lines look like the assistant's text".
  - The pass attaches a labelled file for only 5 of the 10.
  - Its MRR is only slightly above one well-chosen search term (0.45 against 0.40), and its recall is lower
    (45% against 75%).
  - The step 1 bar (recall@10 ≥ 70%) is not met on round 3: 45% in the attached block, 62% in the full ranking.
- **The gate leaks more than tuning suggested.** 7 of 30 chatter messages attach something. Examples are "show
  me the diff", "no, keep the old behaviour" and "did everything pass when you ran it?". Common words like old,
  keep, back, pass and show match many files. Now that the card makes attachments visible, a wrong one is
  noticeable as well as costing about 650 tokens.
- **The fixes still generalise.** Every held-out round improved or held steady, so they were worth making.

### Next steps

1. **Measure the agent's own behaviour with the pass on and off**: tool calls and time to the first read of a
   labelled file. With a hit rate near 50% on independent requests, this decides whether the pass earns its
   tokens, and whether it should stay on by default.
2. **Tighten the gate.** Options are to require at least one matched word that is rare in the workspace, or to
   skip short follow-ups in a running task. Test it against fresh chatter written by someone else.
3. **Embeddings.** Round 3's misses are conceptual, which is the case the plan said to wait for. Add a small
   local embedding model as another benchmark row, and judge it on round 3 plus a fresh independent round.
4. **More independent requests**, ideally real ones from use, before any further tuning.

## Step 2: the pre-analysis pass

The description below is current. The results under it are step 2's, before round 2.

### What happens on each message

When `mitram.retrieveContext` is on (the default), a workspace is open, and the message isn't an automatic
**Continue**, `ChatViewProvider.run()` calls the `Retriever`
([ChatViewProvider.ts:402](../src/webview/ChatViewProvider.ts#L402)) after gathering editor context and the
environment.

1. **Refresh** the index ([codeIndex.ts](../src/agent/codeIndex.ts)).
   - Files come from `git ls-files --cached --others --exclude-standard`, so `.gitignore` is respected, with the
     plain walk as a fallback outside git.
   - Lockfiles, source maps, minified files, SVGs, binaries, files over 512 KB, symlinks and the usual build
     directories are skipped, and at most 20,000 files are indexed.
   - Only files whose modification time or size changed are re-read.
   - The message waits up to 150 ms for the refresh and then uses the index as it stands. The first build gets up
     to 1.5 s; if it isn't done by then, the message goes without retrieval.
   - The index is warmed when the chat view opens and refreshed after every run, so the agent's own edits are
     indexed before the next message.
2. **Rank** ([codeIndex.ts](../src/agent/codeIndex.ts), `search`).
   - Scoring is BM25 (k1 1.2, b 0.75) over file contents, plus 2 × path IDF for a term in the file name and
     0.5 × path IDF for a term in a directory name.
   - Tests count ×0.75 and docs ×0.6, unless the message asks for test work or mentions docs. A test file never
     outranks its own code. Open editor tabs count ×1.2.
   - Terms are words and identifiers, kept whole and split on camelCase and snake_case, with light stemming
     ("summarised" = "summarize", "logs" = "logging"). Stopwords include request verbs and pleasantries.
   - Each word of the message also matches its shorter forms (×0.6) and synonyms (×0.5), and counts once,
     through whichever matches best.
   - Terms are stored as 32-bit hashes in typed arrays, which takes about 9 MB for 7,600 files.
3. **Gate** ([retrieve.ts](../src/agent/retrieve.ts), `isConfident`). Nothing is attached unless both hold:
   - the best file scores at least 4;
   - the message names an identifier (camelCase or snake_case), or one of the top 3 files matches at least two
     of its words.

   Score alone can't separate chatter from requests: "what do you think?" matches `ThinkingBlock.tsx` more
   strongly than several real requests match their targets. Files already attached as context are left out.
4. **Attach** a `<retrieved>` block to the user turn:
   - up to 6 files, as `path:start-end (matched words)`, keeping only those scoring at least 35% of the best;
   - 20-line excerpts from the top 2, around the lines that cover the most query terms;
   - 5,000 characters at most.

   The system prompt says the block can be wrong, and file contents remain untrusted data. Under context
   pressure the block is stripped from older turns, like `<context>`
   ([contextManager.ts](../src/agent/contextManager.ts)). The log records only file counts, sizes and timings.
5. **Show** the attached files as a card under the message (added in round 2).

### Results against the step 1 bar

**How the evaluation was kept honest.** The 24 tuning requests from step 1 were used to design the pass and to
make three adjustments after its first run:

- the test and doc weights;
- the pleasantry stopwords;
- the gate rule.

The 8 held-out requests and the second set of 8 chatter messages were written before the pass ever ran on them,
and were never used for tuning.

| | bar | tuning (24) | held out (8) |
| --- | --- | --- | --- |
| MRR, attached block | ≥ 0.42 (oracle best term) | **0.74** | **0.90** |
| recall@10 | ≥ 70% | 78% (86% before the gate) | 100% |
| any labelled file attached | | 88% | 100% |
| tokens attached | ≤ ~1,500 | median 623, max 962 (all 31 blocks) | |
| for comparison: `search_files`, best single term | | MRR 0.42, recall@10 70% | MRR 0.40, recall@10 88% |

| messages | attached something |
| --- | --- |
| tuning requests | 23 of 24 |
| held-out requests | 8 of 8 |
| chatter, tuning | 1 of 8 ("undo that last change please" matched `slashCommands.ts`) |
| chatter, held out | 1 of 8 |

**Latency and memory.** These are medians in ms. This run was on a loaded machine (load average 3.4), where full
scans took about twice as long as in step 1, so compare rows within a corpus rather than with step 1.

| corpus | files indexed | first build | refresh, no changes | retrieve | `search_files` full scan | index memory |
| --- | --- | --- | --- | --- | --- | --- |
| this repo at `0d3ab3b` | 103 | 60 | 10 | 13 | 43 | < 1 MB |
| working tree | 126 | 77 | 8 | 14 | 76 | < 1 MB |
| `node_modules` (large stand-in) | 7,567 | 4,828 | 429 | 41 | 1,369 | 8.6 MB |

So a message waits about 20 ms on this repo. On the large corpus it waits at most 150 ms for the refresh plus
41 ms to retrieve, which is under the 300 ms bar. The full refresh carries on in the background, so the ranking
there can be one message behind. Excerpts are always read fresh from disk.

### Misses after step 2 (round 2 fixed the first two)

- **revert-created-files.** "Revert this turn leaves behind files the agent created" never reaches
  `checkpoints.ts`, whose code talks about `restore` and `before === null`. This is a vocabulary gap that keyword
  ranking can't close.
- **verify-reminder.** The message mentions "tests", which turns off the test weighting, so test files fill the
  list ahead of `runTracker.ts`.
- **model-picker-memory.** The gate attaches nothing, because no file matches two of the message's words.
- **diagnostics-node-modules, api-key-in-logs, mention-picker-dist.** Only one of the two labelled files is
  attached.

If embeddings are tried later, the vocabulary-gap requests are where they should help. Add them as another row
in the benchmark and compare on the held-out set.

### Limits and next steps

- **Agent effect not measured.** The effect on the agent itself, meaning fewer exploration calls, faster first
  edits and better answers, hasn't been measured, and the pass hasn't been tried end to end in VS Code with a
  model. Next, run the agent on the 32 requests against the snapshot with retrieval on and off, and count tool
  calls before the first read of a labelled file. This needs an endpoint and spends tokens.
- **Tiny workspaces get nothing.** In a workspace of a handful of files every term is common, so the gate never
  passes. That's fine: one `list_dir` shows such a project.
- **Large first build.** On a large workspace the first build is slow (about 5 s for 7,600 files under load).
  Messages sent before it finishes go without retrieval.
- **One folder only.** Only the first workspace folder is indexed, as with the rest of the extension.

## Step 1: how retrieval worked before, and the baseline

### How a message was prepared

1. The webview sends `sendMessage` with the text, `includeActive`, the `@` mentions, plan mode and any attachments
   ([ChatViewProvider.ts:161](../src/webview/ChatViewProvider.ts#L161) → `run()` at
   [:359](../src/webview/ChatViewProvider.ts#L359)).
2. **Editor context.** `gatherContext` ([:392](../src/webview/ChatViewProvider.ts#L392),
   [gatherContext.ts](../src/agent/gatherContext.ts)) attaches the active editor's selection, or the whole file when
   nothing is selected. It then attaches each `@`-mentioned file whole. Every file is cut at 60,000 characters
   from the top. Nothing is chosen for relevance: the user decides what goes in.
3. **Environment.** When `mitram.includeEnvironment` is on (the default), `gatherEnvironment`
   ([gatherEnvironment.ts:19-28](../src/agent/gatherEnvironment.ts#L19-L28)) adds the paths of open tabs, the git
   branch, `git diff --stat` and current diagnostics. It adds **paths only, no file content**.
4. Both are wrapped around the user's text and pushed as the user turn
   ([:410](../src/webview/ChatViewProvider.ts#L410)).
5. Everything else was left to the model. The system prompt tells it to "explore with list_dir, find_files and
   search_files, then read_file" ([SystemPrompt.ts:25](../src/agent/SystemPrompt.ts#L25)). Each exploratory step
   costs one model round trip.

So no retrieval happened before analysis. Step 2 adds it, between steps 3 and 4.

### Search tools and their limits (unchanged by step 2)

| Piece | Behaviour | Limit |
| --- | --- | --- |
| `walkFiles` ([walk.ts](../src/tools/walk.ts)) | Depth-first, alphabetical. A directory's files come before its subdirectories. Skips symlinks and 12 fixed directory names. Does **not** read `.gitignore`. | none |
| `search_files` ([searchFiles.ts](../src/tools/searchFiles.ts)) | Tests the regex on each line and reads files **one at a time**. Matches come back in walk order, with **no relevance ranking and no per-file cap**. | 100 matches, 300 characters per line |
| `find_files` | Glob on the file name, in walk order. **Case-sensitive**, so `*board*` misses `BoardPanel.tsx`. | 200 files |
| Tool results in history | `truncateMiddle` ([AgentLoop.ts:10](../src/agent/AgentLoop.ts#L10)). | 30,000 characters |
| `@` picker ([ChatViewProvider.ts:758](../src/webview/ChatViewProvider.ts#L758)) | `workspace.findFiles`, then a substring match ranked by basename. | 5,000 files scanned, 8 shown |

Three ignore lists disagree: `IGNORED_DIRS` in walk.ts, `FILE_EXCLUDE` in ChatViewProvider.ts, and `.gitignore`.
Only the new index reads `.gitignore`. PLAN.md step 2.3 says `search_files` uses ripgrep, but it doesn't.

### Benchmark design

- **Requests.** [`test/retrieval/requests.ts`](../test/retrieval/requests.ts) has the 24 tuning requests and the
  8 held-out requests, each labelled with the 1–3 files a developer would open first, plus two sets of 8 chatter
  messages. The labels hold at the pinned commit `0d3ab3b`, and the benchmark searches a `git archive` of that
  commit, so the numbers don't drift as the tree changes.
- **Searches.** For the agent's own tools, each request becomes the searches a model could make: all request
  terms in one regex, the average single term, and the best single term. The best term is an oracle and an upper
  bound, because a real model doesn't know which word will work.
- **Metrics.** MRR of the first labelled file; recall@5 and recall@10; "found", meaning any labelled file was
  returned; and the tokens sent to the model (characters ÷ 3.5).

### Baseline findings (tuning set)

- **A broad search is close to useless.** `search_files` with all of a request's terms gives MRR 0.03 and finds
  a labelled file for only 21% of requests. 72% of its matches land in root files (README, PLAN, CHANGELOG,
  `package.json`, `package-lock.json`) and 7% in `sandbox/`. `webview-ui/` and `test/` are never reached before
  the 100-match cap.
- **One well-chosen word works.** The best single term gives MRR 0.42 and recall@10 70%, but a random word from
  the request gives MRR 0.14.
- **`find_files` misses most targets.** It finds a labelled file for 29% of requests even with the best term,
  partly because it is case-sensitive.
- **Full scans grow with repo size.** A full scan takes 20–35 ms on this repo and 0.65–0.85 s on an 8.6k-file
  tree (unloaded machine), because files are read one at a time.

## Not measured yet

- **The agent's exploration cost**, with or without the pass. The eval fixtures have 1–6 files each, so
  `npm run eval` never exercises retrieval. See "Limits and next steps".
- **Cold-cache latency.** The "first" column in the benchmark is the closest available figure.
- **Label bias.** One labeller, 32 requests, one repo. Treat MRR differences below about 0.05 as noise, and add a
  second codebase before tuning further.
