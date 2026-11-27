import { createContext, memo, useContext, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
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
import { isWebUrl } from '@agent-board/daemon/web-url';
import { prefabDraftOfLink } from '@agent-board/daemon/protocol';
import type { Nodes as MdastNodes, PhrasingContent, Root as MdastRoot } from 'mdast';
import { remarkFindings } from '../doc/remark-findings';
import { FindingsTools } from '../doc/FindingsTools';

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
  /**
   * `chat` (the default) is a message's density. `read` is a document's: headings get ids and findings fold (see
   * remarkFindings), styled as `.doc-read`. `card` is the reading styles alone, for text lifted from a document.
   */
  variant?: 'chat' | 'read' | 'card';
  /** Opens an https link in the OS browser. */
  onOpenLink(url: string): void;
}

/**
 * An agent's message as Markdown (CommonMark and GFM: tables, task lists, strikethrough, autolinks), with its code
 * blocks highlighted. Its text comes from outside the app, so nothing in it runs or loads: raw HTML is dropped, an
 * image shows only its alt text, and only an https link is a link, opened in the OS browser, besides the link to a
 * crew an agent drafted (written bare too), which opens it on its board. Memoised on its text: a
 * long transcript re-renders only what changed.
 */
export const Markdown = memo(function Markdown({ text, onOpenLink, variant = 'chat' }: MarkdownProps) {
  // The components are the same objects every render: a new one is a new element type, which would remount (and so
  // refold) every finding whenever the text changed.
  return (
    <OpenLink.Provider value={onOpenLink}>
      <div className={variant === 'chat' ? 'chat-md' : variant === 'read' ? 'doc-read' : 'doc-read doc-read-card'}>
        <ReactMarkdown
          remarkPlugins={variant === 'read' ? READ_PLUGINS : CHAT_PLUGINS}
          rehypePlugins={[rehypeHighlight]}
          skipHtml
          urlTransform={keepDraftLinks}
          components={variant === 'read' ? READ_COMPONENTS : CHAT_COMPONENTS}
        >
          {text}
        </ReactMarkdown>
      </div>
    </OpenLink.Provider>
  );
});

/** How a link in the Markdown opens: the OS browser, as the Markdown's owner says. */
const OpenLink = createContext<(url: string) => void>(() => {});

const CHAT_COMPONENTS: Components = {
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ alt }) => (alt ? <span className="chat-md-image">{alt}</span> : null),
  pre: ({ children }) => <pre className="chat-md-code">{children}</pre>,
  // A task list's boxes show what is done; they aren't for ticking here.
  input: ({ type, checked }) => (type === 'checkbox' ? <input type="checkbox" disabled checked={checked} /> : null),
};

const READ_COMPONENTS: Components = {
  ...CHAT_COMPONENTS,
  div: ({ node, className, children, ...rest }) =>
    className === 'findings-tools' ? (
      <FindingsTools count={Number(node?.properties.dataCount ?? 0)} />
    ) : (
      <div className={className} {...rest}>
        {children}
      </div>
    ),
  // A wide table scrolls sideways in its own box, not the page.
  table: ({ children }) => (
    <div className="read-table">
      <table>{children}</table>
    </div>
  ),
};

const DRAFT_LINK = /agent-board:\/\/draft\/[0-9a-f-]+/gi;

/**
 * Makes the link to a drafted crew, written bare in the text, a link: GFM autolinks only the web's schemes. Not in
 * code, nor inside a link already.
 */
function remarkDraftLinks() {
  return (tree: MdastRoot) => {
    const visit = (node: MdastNodes) => {
      if (!('children' in node) || node.type === 'link') return;
      node.children = (node.children as MdastNodes[]).flatMap((child): MdastNodes[] => {
        if (child.type !== 'text') {
          visit(child);
          return [child];
        }
        const parts: PhrasingContent[] = [];
        let from = 0;
        for (const match of child.value.matchAll(DRAFT_LINK)) {
          if (prefabDraftOfLink(match[0]) === undefined) continue;
          if (match.index > from) parts.push({ type: 'text', value: child.value.slice(from, match.index) });
          parts.push({ type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] });
          from = match.index + match[0].length;
        }
        if (parts.length === 0) return [child];
        if (from < child.value.length) parts.push({ type: 'text', value: child.value.slice(from) });
        return parts;
      }) as typeof node.children;
    };
    visit(tree);
  };
}

/** react-markdown's own rules for a link's address, which drop a scheme of the app's own: the draft link is kept. */
const keepDraftLinks = (url: string): string => (prefabDraftOfLink(url) === undefined ? defaultUrlTransform(url) : url);

const CHAT_PLUGINS = [remarkGfm, remarkDraftLinks];
const READ_PLUGINS = [remarkGfm, remarkFindings, remarkDraftLinks];

function Link({ href, children }: { href: string | undefined; children: ReactNode }) {
  const onOpenLink = useContext(OpenLink);
  const draft = href === undefined ? undefined : prefabDraftOfLink(href);
  if (draft !== undefined)
    return (
      <a
        href={href}
        title="Opens the draft on its board"
        onClick={(event) => {
          event.preventDefault();
          void window.agentBoard.windows.requestBoard({ kind: 'prefabDraft', id: draft });
        }}
      >
        {children}
      </a>
    );
  if (href === undefined || !isWebUrl(href)) return <>{children}</>;
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
