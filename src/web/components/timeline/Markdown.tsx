import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '../ui';

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastText(n: HastNode | undefined): string {
  if (!n) return '';
  if (n.type === 'text') return n.value ?? '';
  return (n.children ?? []).map(hastText).join('');
}

const components: Components = {
  pre({ node }) {
    const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === 'code');
    const cls = code?.properties?.className;
    const lang = Array.isArray(cls) ? String(cls.find((c) => String(c).startsWith('language-')) ?? '').slice(9) : '';
    const text = hastText(code).replace(/\n$/, '');
    return (
      <div className="md-code">
        <div className="md-code-bar">
          <span className="md-code-lang mono">{lang}</span>
          <CopyButton text={text} label="Copy code" />
        </div>
        <pre>
          <code>{text}</code>
        </pre>
      </div>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="md-table">
        <table>{children}</table>
      </div>
    );
  },
};

const plugins = [remarkGfm];

export const MarkdownText = memo(function MarkdownText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md${streaming ? ' is-streaming' : ''}`}>
      <Markdown remarkPlugins={plugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
