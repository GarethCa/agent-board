import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createLowlight } from 'lowlight';
import { toText } from 'hast-util-to-text';
import type { Element, ElementContent, Root } from 'hast';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * The languages a code block is highlighted in: what agents mostly write here, bundled with the app (each grammar is a
 * few KB). A block in any other, or none, is plain. Each grammar brings its aliases (`ts`, `sh`, `html`, `yml`…).
 */
const lowlight = createLowlight({ bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, swift, typescript, xml, yaml });

/** Highlights each fenced code block whose language the app knows, as lowlight's `hljs-*` spans. */
function rehypeHighlight() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== 'element') continue;
        const code = child.tagName === 'pre' ? child.children.find((inner): inner is Element => inner.type === 'element' && inner.tagName === 'code') : undefined;
        const language = code && languageOf(code);
        if (code && language !== undefined) code.children = lowlight.highlight(language, toText(code, { whitespace: 'pre' })).children as ElementContent[];
        else visit(child);
      }
    };
    visit(tree);
  };
}

/** A code element's `language-*` class, if lowlight has that language. */
function languageOf(code: Element): string | undefined {
  const classes = code.properties.className;
  const named = Array.isArray(classes) ? classes.find((name) => String(name).startsWith('language-')) : undefined;
  const language = named === undefined ? undefined : String(named).slice('language-'.length);
  return language !== undefined && lowlight.registered(language) ? language : undefined;
}

interface MarkdownProps {
  text: string;
  /** Opens an https link in the OS browser. */
  onOpenLink(url: string): void;
}

/**
 * An agent's message as Markdown (CommonMark and GFM: tables, task lists, strikethrough, autolinks), with its code
 * blocks highlighted. Its text comes from outside the app, so nothing in it runs or loads: raw HTML is dropped, an
 * image shows only its alt text, and only an https link is a link, opened in the OS browser. Memoised on its text: a
 * long transcript re-renders only what changed.
 */
export const Markdown = memo(function Markdown({ text, onOpenLink }: MarkdownProps) {
  const components: Components = {
    a: ({ href, children }) => <Link href={href} onOpenLink={onOpenLink}>{children}</Link>,
    img: ({ alt }) => (alt ? <span className="chat-md-image">{alt}</span> : null),
    pre: ({ children }) => <pre className="chat-md-code">{children}</pre>,
    // A task list's boxes show what is done; they aren't for ticking here.
    input: ({ type, checked }) => (type === 'checkbox' ? <input type="checkbox" disabled checked={checked} /> : null),
  };
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function Link({ href, onOpenLink, children }: { href: string | undefined; onOpenLink(url: string): void; children: ReactNode }) {
  if (href === undefined || !href.startsWith('https://')) return <>{children}</>;
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        onOpenLink(href);
      }}
    >
      {children}
    </a>
  );
}
