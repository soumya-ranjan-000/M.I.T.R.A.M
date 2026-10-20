import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlight } from '../highlight';
import { splitMarkdown } from '../markdownChunks';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  // Highlighting is the costly part of a code block and its inputs rarely change.
  const html = useMemo(() => highlight(code, lang), [code, lang]);

  function copy() {
    postToHost({ type: 'copyCode', code });
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="codeblock">
      <div className="codeblock-header">
        <span>{lang ?? 'text'}</span>
        <span className="codeblock-actions">
          <button className="icon-btn small" onClick={copy} title="Copy code" aria-label="Copy code">
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
          <button
            className="icon-btn small"
            onClick={() => postToHost({ type: 'insertCode', code })}
            title="Insert at cursor"
            aria-label="Insert at cursor"
          >
            <Icon name="insert" size={13} />
          </button>
        </span>
      </div>
      <pre>
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}

const COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code({ className, children }: { className?: string; children?: React.ReactNode }) {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1];
    const code = String(children).replace(/\n$/, '');
    if (!lang && !code.includes('\n')) return <code className="inline">{code}</code>;
    return <CodeBlock code={code} lang={lang} />;
  },
  a: ({ children }: { children?: React.ReactNode }) => <span className="link">{children}</span>,
};
const PLUGINS = [remarkGfm];

/** One parsed block. Memoised on its text, so a finished block is never parsed again. */
const Chunk = memo(function Chunk({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Markdown for a reply. While a long reply streams in, only its last block changes, so it is split
 * into blocks and only that one is parsed again for each update.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const chunks = useMemo(() => splitMarkdown(text), [text]);
  return (
    <div className="markdown">
      {chunks.map((chunk, i) => (
        <Chunk key={i} text={chunk} />
      ))}
    </div>
  );
});
