import type { RetrievalRequest } from './requests';

/** Held out, round 3: written by a separate agent that never saw the retrieval code. */
export const heldout3: RetrievalRequest[] = [
  {
    id: 'blocked-patterns-invalid-regex-warning',
    text:
      'If I put an invalid regex in mitram.blockedCommandPatterns it is just silently skipped, so I think a command is ' +
      "blocked when it really isn't. Show me a warning when one of my patterns doesn't compile.",
    kind: 'identifier',
    gold: ['src/safety/commandPolicy.ts', 'src/webview/ChatViewProvider.ts'],
    heldout: 3,
  },
  {
    id: 'run-command-forces-ci-env',
    text:
      'run_command always sets CI=1 in the environment, which makes our jest config pick a different reporter than in my ' +
      "terminal. Can we stop forcing it, or at least not override it when I've already set it?",
    kind: 'identifier',
    gold: ['src/tools/runCommand.ts'],
    heldout: 3,
  },
  {
    id: 'describe-error-404-show-host-and-deployment',
    text:
      'On a 404, describeError only tells me to check the endpoint URL and the model name. Include the actual host and ' +
      'deployment name it tried so I can tell which one is wrong.',
    kind: 'identifier',
    gold: ['src/providers/ModelProvider.ts', 'src/webview/ChatViewProvider.ts'],
    heldout: 3,
  },
  {
    id: 'second-project-folder-ignored',
    text:
      'I have two project folders open in the same window and the assistant only ever sees the first one. It cannot read or ' +
      'change anything in the second folder, and when I tag a file from there nothing gets attached.',
    kind: 'natural',
    gold: ['src/webview/ChatViewProvider.ts', 'src/agent/gatherContext.ts'],
    heldout: 3,
  },
  {
    id: 'old-chats-disappear-from-list',
    text:
      "My older conversations vanish from the list of past chats after a while, and I never deleted them. Is there a cap on " +
      "how many are kept? I'd like it to hold on to more.",
    kind: 'natural',
    gold: ['src/storage/sessions.ts'],
    heldout: 3,
  },
  {
    id: 'big-tagged-file-only-first-chunk',
    text:
      'When I tag a big file, the model only gets the first chunk of it and the rest is quietly chopped off. Can it send ' +
      'more of the file, or at least tell me in the chat that it was cut short?',
    kind: 'natural',
    gold: ['src/agent/gatherContext.ts', 'src/agent/ContextBuilder.ts'],
    heldout: 3,
  },
  {
    id: 'long-answer-ends-abruptly-auto-resume',
    text:
      'Sometimes a long answer ends abruptly in the middle of a sentence with a little note about hitting the length limit, ' +
      'and then it just sits there. Could it pick up where it stopped by itself instead of making me ask again?',
    kind: 'natural',
    gold: ['src/agent/AgentLoop.ts'],
    heldout: 3,
  },
  {
    id: 'status-lines-look-like-assistant-text',
    text:
      'Status lines from the extension itself, like when it shortens the conversation or pauses after running a long time, ' +
      'show up in italics under the assistant as if it wrote them. They should look like separate system lines, not part of the reply.',
    kind: 'natural',
    gold: ['src/webview/displayReducer.ts', 'src/webview/protocol.ts', 'webview-ui/src/App.tsx'],
    heldout: 3,
  },
  {
    id: 'urls-in-answers-not-clickable',
    text:
      "URLs the assistant puts in its answers can't be clicked, they're just plain coloured text. Clicking one should open it in my browser.",
    kind: 'natural',
    gold: ['webview-ui/src/components/Markdown.tsx', 'src/webview/protocol.ts', 'src/webview/ChatViewProvider.ts'],
    heldout: 3,
  },
  {
    id: 'keyboard-yes-no-on-pending-change',
    text:
      "I'd like to say yes or no to a pending file change from the keyboard, say Enter and Esc, instead of reaching for the mouse every time.",
    kind: 'natural',
    gold: ['webview-ui/src/components/ToolCard.tsx', 'webview-ui/src/App.tsx'],
    heldout: 3,
  },
];

/** Held-out chatter, round 3. */
export const heldoutChatter3: string[] = [
  'Yes, go ahead with that.',
  'Hmm, not quite. Can you have another go at it?',
  'Why did you touch the second file as well?',
  'Nice, thanks!',
  'Actually, put it back the way it was, I preferred the old version.',
  'Did everything pass when you ran it?',
];
