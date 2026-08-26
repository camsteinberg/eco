// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { memo, useRef, useEffect, useMemo, useState, isValidElement, cloneElement, Fragment } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { motion, useReducedMotion } from "motion/react";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import { CodeBlock } from "./CodeBlock";
import { normalizeStreamMarkdown } from "../../lib/stream-markdown-normalizer";

type MarkdownRendererProps = {
  content: string;
  /** When true, disables expensive syntax highlighting and enables per-block fade-in. */
  isStreaming?: boolean;
  /** When true, [N] markers in text are rendered as superscript citation links. */
  hasCitations?: boolean;
};

// Stable references — avoids new array allocations on every render
const REHYPE_NO_HIGHLIGHT: PluggableList = [];
const REHYPE_HIGHLIGHT: PluggableList = [rehypeHighlight];

// Map block-level tags to their Motion v12 counterparts for streaming fade-in.
const MOTION_TAGS = {
  p: motion.p,
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  h4: motion.h4,
  li: motion.li,
} as const;

// ---------------------------------------------------------------------------
// Progressive syntax highlighting during streaming
//
// Heuristic: count all triple-backtick sequences (```) in the buffer.
// - Even count → every fence is paired (closed) → safe to highlight.
// - Odd count → the last fence is still open → skip highlighting to avoid
//   flicker as tokens stream into the open block and the inferred language
//   shifts on every character.
//
// Limitation: escaped backticks and nested fenced blocks can throw the count
// off. For v1, treating all ``` sequences identically is good enough.
// TODO: debounce if perf regresses on very long messages (250ms pause gate).
// ---------------------------------------------------------------------------
/** @internal Exported for testing only. */
export function hasOpenFence(content: string): boolean {
  const fenceCount = content.match(/```/g)?.length ?? 0;
  return fenceCount % 2 === 1;
}

// ---------------------------------------------------------------------------
// Lazy-loaded KaTeX math plugins
//
// KaTeX is ~280KB gzipped — we only load it when the message actually contains
// math notation. Detection uses a conservative regex that avoids false positives
// on monetary amounts like "$5 and $10":
//
// - Display math ($$...$$): always detected.
// - Inline math ($...$): only if the content between dollars contains at least
//   one LaTeX-specific character (^, _, or \). Plain "$5" is left alone.
//
// Both the JS plugins and the CSS are loaded via dynamic import so they end up
// in a separate webpack/turbopack chunk, not in the main bundle.
// ---------------------------------------------------------------------------

/**
 * Conservative math-detection regex. See comment block above for rationale.
 * @internal Exported for testing only.
 */
export const MATH_DETECT = /\$\$[\s\S]+?\$\$|\$(?=[^\s$])(?=[^$]*[\\^_])[^$]+(?<=[^\s$])\$/;

type MathPlugins = {
  remark: PluggableList;
  rehype: PluggableList;
};

const EMPTY_MATH_PLUGINS: MathPlugins = { remark: [], rehype: [] };

function useMathPlugins(content: string): MathPlugins {
  const needsMath = MATH_DETECT.test(content);
  const [plugins, setPlugins] = useState<MathPlugins>(EMPTY_MATH_PLUGINS);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!needsMath || loadedRef.current) return;
    let cancelled = false;

    (async () => {
      const [{ default: remarkMath }, { default: rehypeKatex }] = await Promise.all([
        import("remark-math"),
        import("rehype-katex"),
        // Side-effect import: injects KaTeX CSS into the document
        import("katex/dist/katex.min.css"),
      ]);
      if (!cancelled) {
        loadedRef.current = true;
        setPlugins({
          remark: [remarkMath],
          // `trust: false` is KaTeX's default, but pin it explicitly: it disables
          // `\href`, `\htmlData`, and `\includegraphics`, which are the only KaTeX
          // primitives that can emit scriptable/navigable markup. Model output is
          // untrusted, so a future rehype-katex/KaTeX default change must not be
          // able to silently re-enable them.
          rehype: [[rehypeKatex, { trust: false }]],
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [needsMath]);

  return plugins;
}

// ---------------------------------------------------------------------------
// Table-cell line breaks — convert literal `<br>` markers small models emit
// inside GFM cells into real breaks, scoped to td/th.
// ---------------------------------------------------------------------------

const CELL_BREAK = /<br\s*\/?>/gi;

// Security: we synthesize only our own <br/> elements — assistant HTML is never
// parsed (no rehype-raw), so the no-raw-HTML posture is preserved.
function renderCellBreaks(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    const parts = children.split(CELL_BREAK);
    if (parts.length === 1) return children;
    return parts.flatMap((part, i) =>
      i === 0 ? [part] : [<br key={`cell-br-${String(i)}`} />, part],
    );
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      const rendered = renderCellBreaks(child);
      if (Array.isArray(rendered)) {
        return <Fragment key={`cell-part-${String(i)}`}>{rendered}</Fragment>;
      }
      return rendered;
    });
  }
  if (isValidElement(children)) {
    const el = children as React.ReactElement<{
      node?: { tagName?: string };
      children?: React.ReactNode;
    }>;
    // A <br> inside inline code is literal content — never descend into `code`.
    if (el.props.node?.tagName === "code") return children;
    if (el.props.children === undefined) return children;
    return cloneElement(el, undefined, renderCellBreaks(el.props.children));
  }
  return children;
}

// ---------------------------------------------------------------------------
// Code text extraction
//
// When syntax highlighting is active (rehype-highlight — which runs on every
// finalized message and any closed fence), a fenced code block's `children`
// are an array of highlight <span> element nodes, not a plain string.
// `String(children)` on that array yields "[object Object],…", mangling the
// code. Reconstruct the raw source by walking the node tree and concatenating
// its text leaves in order — whitespace- and punctuation-exact.
// ---------------------------------------------------------------------------

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

// Strip a single trailing newline from the (possibly highlighted) code node
// tree. rehype-highlight preserves the fenced block's trailing "\n"; rendering
// that verbatim would leave a blank final line in the <pre> — and would make the
// block's textContent no longer equal the exact source. Walks only the last leaf
// so the highlight spans stay intact.
function trimTrailingNewline(node: React.ReactNode): React.ReactNode {
  if (typeof node === "string") return node.replace(/\n$/, "");
  if (Array.isArray(node)) {
    if (node.length === 0) return node;
    const lastIndex = node.length - 1;
    const trimmedLast = trimTrailingNewline(node[lastIndex]);
    return node.map((child, i) => (i === lastIndex ? trimmedLast : child));
  }
  if (isValidElement(node)) {
    const kids = (node.props as { children?: React.ReactNode }).children;
    if (kids === undefined) return node;
    return cloneElement(node, undefined, trimTrailingNewline(kids));
  }
  return node;
}

// ---------------------------------------------------------------------------
// Static components (used when NOT streaming, or for reduced motion)
// ---------------------------------------------------------------------------

const staticComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--eco-code-link)] underline decoration-[var(--eco-code-link-decoration)] hover:opacity-80"
      {...props}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\S+)/.exec(className ?? "");
    const codeString = extractText(children).replace(/\n$/, "");

    if (match) {
      const lang = match[1] ?? "text";

      return (
        <CodeBlock code={codeString} language={lang}>
          {trimTrailingNewline(children)}
        </CodeBlock>
      );
    }

    return (
      <code
        className="rounded bg-[var(--eco-code-inline-bg)] px-1 py-0.5 font-mono text-sm text-[var(--eco-code-inline-text)]"
        {...props}
      >
        {children}
      </code>
    );
  },
  table: ({ children, ...props }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-[var(--eco-border)]/70 bg-[var(--eco-surface-elevated)]/55">
      <table className="min-w-full text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th className="border-b border-[var(--eco-neutral-border)] px-3 py-2 text-left font-semibold" {...props}>
      {renderCellBreaks(children)}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border-b border-[var(--eco-neutral-border-muted)] px-3 py-2" {...props}>
      {renderCellBreaks(children)}
    </td>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-4 rounded-xl border border-[var(--eco-border)]/60 bg-[var(--eco-primary-soft)]/15 px-4 py-3 text-[var(--eco-text-muted)]"
      {...props}
    >
      {children}
    </blockquote>
  ),
  h1: ({ children, ...props }) => (
    <h1 className="mb-3 mt-5 font-[family-name:var(--eco-font-display)] text-2xl font-semibold tracking-[-0.01em]" {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mb-2.5 mt-5 font-[family-name:var(--eco-font-display)] text-xl font-semibold tracking-[-0.01em]" {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mb-1.5 mt-4 font-[family-name:var(--eco-font-display)] text-base font-semibold" {...props}>{children}</h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="mb-1 mt-3 text-sm font-semibold uppercase tracking-[0.08em] text-[var(--eco-text-muted)]" {...props}>{children}</h4>
  ),
  ul: ({ children, ...props }) => (
    <ul className="my-3 list-outside list-disc space-y-1.5 pl-5 leading-relaxed" {...props}>{children}</ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="my-3 list-outside list-decimal space-y-1.5 pl-5 leading-relaxed" {...props}>{children}</ol>
  ),
  li: ({ children, ...props }) => (
    <li className="pl-1 marker:text-[var(--eco-text-muted)]" {...props}>{children}</li>
  ),
  p: ({ children, ...props }) => (
    <p className="my-2 leading-7" {...props}>{children}</p>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-[var(--eco-text)]" {...props}>{children}</strong>
  ),
  em: ({ children, ...props }) => (
    <em className="text-[var(--eco-text-secondary)]" {...props}>{children}</em>
  ),
  hr: ({ ...props }) => (
    <hr className="my-5 border-[var(--eco-border)]/70" {...props} />
  ),
};

// ---------------------------------------------------------------------------
// Streaming-aware component factory
// Uses a mutable counter ref to track block index during a single render pass.
// Only blocks beyond prevBlockCount get the fade-in animation.
// ---------------------------------------------------------------------------

/** Maximum cumulative stagger delay (seconds) — prevents long lists from feeling sluggish. */
const MAX_STAGGER_DELAY_S = 0.3;
/** Per-block stagger increment (seconds). */
const STAGGER_INCREMENT_S = 0.06;

function createStreamingComponents(
  blockIndexRef: React.MutableRefObject<number>,
  prevBlockCountRef: React.MutableRefObject<number>,
  shouldAnimate: boolean,
): Components {
  type StreamingBlockProps = Omit<
    React.HTMLAttributes<HTMLElement>,
    | "onAnimationEnd"
    | "onAnimationIteration"
    | "onAnimationStart"
    | "onDrag"
    | "onDragEnd"
    | "onDragStart"
  >;

  /** Wraps a block-level element with fade-in animation for new blocks. */
  function withFadeIn(
    Tag: keyof typeof MOTION_TAGS,
    className: string,
  ) {
    const MotionTag = MOTION_TAGS[Tag];

    return function StreamingBlock({
      children,
      ...props
    }: StreamingBlockProps) {
      // Read prevBlockCountRef LIVE at decision time. The ref holds the
      // previous render's final block count (the post-commit useEffect only
      // updates it after this render commits), so reading it here is
      // behavior-equivalent to capturing it by value — but it lets the
      // `components` object stay identity-stable across streamed tokens
      // instead of being recreated on every token.
      const prevBlockCount = prevBlockCountRef.current;
      const idx = blockIndexRef.current++;
      const isNew = shouldAnimate && idx >= prevBlockCount;

      if (isNew) {
        const staggerIndex = idx - prevBlockCount;
        const staggerDelay = Math.min(
          staggerIndex * STAGGER_INCREMENT_S,
          MAX_STAGGER_DELAY_S,
        );

        return (
          <MotionTag
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{
              delay: staggerDelay,
              type: 'spring',
              stiffness: 300,
              damping: 32,
            }}
            className={className}
            data-stagger-index={staggerIndex}
            {...props}
          >
            {children as React.ReactNode}
          </MotionTag>
        );
      }

      // Already-seen block: render as plain HTML (no animation overhead)
      const El = Tag;
      return <El className={className} {...props}>{children as React.ReactNode}</El>;
    };
  }

  return {
    ...staticComponents,
    p: withFadeIn("p", "my-2 leading-7"),
    h1: withFadeIn("h1", "mb-3 mt-5 font-[family-name:var(--eco-font-display)] text-2xl font-semibold tracking-[-0.01em]"),
    h2: withFadeIn("h2", "mb-2.5 mt-5 font-[family-name:var(--eco-font-display)] text-xl font-semibold tracking-[-0.01em]"),
    h3: withFadeIn("h3", "mb-1.5 mt-4 font-[family-name:var(--eco-font-display)] text-base font-semibold"),
    h4: withFadeIn("h4", "mb-1 mt-3 text-sm font-semibold uppercase tracking-[0.08em] text-[var(--eco-text-muted)]"),
    li: withFadeIn("li", "pl-1 marker:text-[var(--eco-text-muted)]"),
  };
}

// ---------------------------------------------------------------------------
// Citation superscript replacement
// ---------------------------------------------------------------------------

/** Replace [N] markers in text nodes with styled superscript citation links. */
function renderWithCitations(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    const parts = children.split(/(\[\d+\])/g);
    if (parts.length === 1) return children;
    return parts.map((part, i) => {
      const match = /^\[(\d+)\]$/.exec(part);
      if (match) {
        const num = match[1]!;
        return (
          <a
            key={`cite-${num}-${String(i)}`}
            href={`#citation-${num}`}
            className="cursor-pointer no-underline"
            style={{ color: "var(--eco-primary)" }}
            onClick={(e) => {
              e.preventDefault();
              const el = document.getElementById(`citation-${num}`);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          >
            <sup className="text-[10px] font-semibold">[{num}]</sup>
          </a>
        );
      }
      return part;
    });
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === "string") {
        const result = renderWithCitations(child);
        // Wrap string results in a fragment with key when they expand
        if (Array.isArray(result)) {
          return <span key={String(i)}>{result}</span>;
        }
        return result;
      }
      return child;
    });
  }
  return children;
}

/**
 * Create a `p` component override that renders [N] citation markers as
 * clickable superscript links when hasCitations is true.
 */
function createCitationP(baseClassName: string) {
  return function CitationP(props: React.HTMLAttributes<HTMLParagraphElement>) {
    const { children, ...rest } = props;
    return (
      <p className={baseClassName} {...rest}>
        {renderWithCitations(children)}
      </p>
    );
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Memoized on purpose — and this memo is load-bearing. During streaming the
 * chat store publishes a new messages array on every metered token slice
 * (~every animation frame), which re-renders every bubble in the list. All
 * three props here are primitives, so `memo` lets every COMPLETED message
 * skip the whole markdown pipeline (normalize → remark → rehype → highlight)
 * on those ticks; only the streaming message, whose `content` is actually
 * changing, re-parses. Keep the props primitive — an object or inline-lambda
 * prop would silently defeat this.
 */
export const MarkdownRenderer = memo(MarkdownRendererImpl);

function MarkdownRendererImpl({ content, isStreaming = false, hasCitations = false }: MarkdownRendererProps) {
  const shouldReduce = useReducedMotion();

  // Track how many block-level elements have been rendered in previous passes.
  // This ensures only NEW blocks (appended during streaming) animate.
  const prevBlockCountRef = useRef(0);
  const blockIndexRef = useRef(0);

  // After each render, update the "seen" block count so those blocks won't
  // animate on the next render pass.
  useEffect(() => {
    prevBlockCountRef.current = blockIndexRef.current;
  });

  // Reset block counter at the start of each render
  blockIndexRef.current = 0;

  const shouldAnimate = isStreaming && !shouldReduce;

  // --- Host-side markdown normalization ---
  // Repair the formatting artifacts small on-device models emit (glued heading
  // hashes, glued list markers, separator-less pipe tables, doubled spaces) BEFORE
  // parsing, so the same deterministic output drives rendering AND the finalize
  // path. `complete` reflects whether the message is still streaming: while
  // streaming the trailing partial line is preserved verbatim to avoid flicker.
  // Memoized on [content, isStreaming] — recomputed only when the body actually
  // changes, not on unrelated re-renders (theme, hover, etc.).
  const normalized = useMemo(
    () => normalizeStreamMarkdown(content, { complete: !isStreaming }),
    [content, isStreaming],
  );

  // --- Progressive syntax highlighting ---
  // During streaming: highlight only when all fences are closed (even count).
  // When not streaming: always highlight (final render).
  const rehypePlugins = useMemo<PluggableList>(() => {
    if (!isStreaming) return REHYPE_HIGHLIGHT;
    return hasOpenFence(normalized) ? REHYPE_NO_HIGHLIGHT : REHYPE_HIGHLIGHT;
  }, [isStreaming, normalized]);

  // --- Lazy KaTeX math ---
  const mathPlugins = useMathPlugins(normalized);

  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkGfm, ...mathPlugins.remark],
    [mathPlugins.remark],
  );

  const finalRehypePlugins = useMemo<PluggableList>(
    () => [...rehypePlugins, ...mathPlugins.rehype],
    [rehypePlugins, mathPlugins.rehype],
  );

  // NOTE: `content.length` is intentionally NOT a dependency. The streaming
  // components read `blockIndexRef` / `prevBlockCountRef` LIVE during render
  // (see createStreamingComponents), so the reveal animation stays correct
  // without recreating this object on every streamed token. Keeping the object
  // identity stable lets ReactMarkdown skip re-rendering unchanged custom
  // blocks (syntax-highlighted code, KaTeX) on every token — the O(n²) cost
  // this avoids.
  const components = useMemo(() => {
    let base: Components;
    if (!isStreaming || shouldReduce) {
      base = staticComponents;
    } else {
      base = createStreamingComponents(
        blockIndexRef,
        prevBlockCountRef,
        shouldAnimate,
      );
    }
    // When citations are present, override `p` to render [N] as superscript links
    if (hasCitations) {
      return { ...base, p: createCitationP("my-2 leading-7") } as Components;
    }
    return base;
  }, [isStreaming, shouldReduce, shouldAnimate, hasCitations]);

  return (
    <div className="eco-chat-markdown text-[0.9375rem] leading-7 text-[var(--eco-text)]">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={finalRehypePlugins}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
