import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlight } from '../highlight';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const html = highlight(code, lang);

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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code({ className, children }) {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            const code = String(children).replace(/\n$/, '');
            if (!lang && !code.includes('\n')) return <code className="inline">{code}</code>;
            return <CodeBlock code={code} lang={lang} />;
          },
          a: ({ children }) => <span className="link">{children}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
