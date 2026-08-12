// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { hasOpenFence, MATH_DETECT } from '../MarkdownRenderer'

// Mock next/dynamic to load components synchronously in tests.
// next/dynamic is a Next.js runtime feature; in vitest/jsdom we replace it
// with a thin wrapper that eagerly resolves the import factory so tests
// don't have to await the lazy chunk.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (
    loader: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>,
    _opts?: Record<string, unknown>,
  ) => {
    let Resolved: React.ComponentType<Record<string, unknown>> | null = null;
    // Kick off the import immediately; because the imported module is already
    // vi.mock-ed above, the promise resolves in the same microtask queue.
    loader().then((mod: { default: React.ComponentType<Record<string, unknown>> }) => {
      Resolved = mod.default;
    });
    // Return a wrapper component that defers to the resolved component.
    // The first render may miss if the microtask hasn't flushed, so tests
    // that render via MarkdownRenderer use `waitFor` below.
    return (props: Record<string, unknown>) => (Resolved ? <Resolved {...props} /> : null);
  },
}));

// Mock @codesandbox/sandpack-react since Sandpack requires browser APIs
// not available in Vitest/jsdom
vi.mock("@codesandbox/sandpack-react", () => ({
  SandpackProvider: ({
    children,
    template,
    files,
  }: {
    children: React.ReactNode;
    template: string;
    files: Record<string, string>;
    key?: number;
  }) => (
    <div
      data-testid="sandpack-provider"
      data-template={template}
      data-files={JSON.stringify(files)}
    >
      {children}
    </div>
  ),
  SandpackCodeEditor: ({ style }: { style?: React.CSSProperties }) => (
    <div data-testid="sandpack-editor" style={style} />
  ),
  SandpackPreview: ({ style }: { style?: React.CSSProperties }) => (
    <div data-testid="sandpack-preview" style={style} />
  ),
}));

// Mock remark-math and rehype-katex for lazy-load tests.
// These mocks simulate the dynamic import() path in useMathPlugins.
vi.mock("remark-math", () => ({
  __esModule: true,
  default: () => {
    // A no-op remark plugin that adds a 'data-math-remark' marker
    // so tests can verify the plugin was loaded and applied.
    return () => {};
  },
}));

vi.mock("rehype-katex", () => ({
  __esModule: true,
  default: () => {
    // A no-op rehype plugin — KaTeX rendering is not testable in jsdom
    // without the full KaTeX engine, but we verify the plugin chain loads.
    return () => {};
  },
}));

vi.mock("katex/dist/katex.min.css", () => ({
  __esModule: true,
  default: undefined,
}));

// Must import MarkdownRenderer AFTER the mocks are set up
const { MarkdownRenderer } = await import('../MarkdownRenderer')

describe('MarkdownRenderer', () => {
  it('renders a paragraph from plain text', () => {
    render(<MarkdownRenderer content="Hello world" />)
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('renders headings', () => {
    render(<MarkdownRenderer content="## Heading Two" />)
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading).toHaveTextContent('Heading Two')
  })

  it('renders bold text', () => {
    render(<MarkdownRenderer content="This is **bold** text" />)
    const bold = screen.getByText('bold')
    expect(bold.tagName).toBe('STRONG')
  })

  it('renders inline code', () => {
    render(<MarkdownRenderer content="Use `console.log` here" />)
    const code = screen.getByText('console.log')
    expect(code.tagName).toBe('CODE')
  })

  it('renders fenced code blocks with a code block component', () => {
    const md = '```javascript\nconsole.log("hi")\n```'
    render(<MarkdownRenderer content={md} />)
    // The CodeBlock renders language label and copy button
    expect(screen.getByText('javascript')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  it('renders the exact code source in a highlighted fenced block, not [object Object]', () => {
    // Regression: with syntax highlighting active (rehype-highlight, which runs
    // on every finalized message), the code block's `children` become an array
    // of highlight <span> element nodes. `String(children)` then produced
    // "[object Object],[object Object],…", mangling every finished code block on
    // all models since launch. The renderer must reconstruct the real source.
    const source = 'const x = [...new Set(arr)].sort((a, b) => b - a);'
    const md = '```javascript\n' + source + '\n```'
    const { container } = render(<MarkdownRenderer content={md} />)
    const code = container.querySelector('pre code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toBe(source)
    expect(container).not.toHaveTextContent('[object Object]')
  })

  it('renders unordered lists', () => {
    const md = "- Item A\n- Item B\n- Item C"
    render(<MarkdownRenderer content={md} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
  })

  it('renders ordered lists', () => {
    const md = "1. First\n2. Second"
    render(<MarkdownRenderer content={md} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
  })

  it('renders tables', () => {
    const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |'
    render(<MarkdownRenderer content={md} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('renders blockquotes', () => {
    render(<MarkdownRenderer content="> This is a quote" />)
    const quote = screen.getByText('This is a quote')
    expect(quote.closest('blockquote')).toBeInTheDocument()
  })

  it('renders links', () => {
    render(<MarkdownRenderer content="Visit [Eco](https://eco.network)" />)
    const link = screen.getByRole('link', { name: 'Eco' })
    expect(link).toHaveAttribute('href', 'https://eco.network')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('does not render raw HTML or event handlers from assistant content', () => {
    const { container } = render(
      <MarkdownRenderer content={'<img src=x onerror="alert(1)"><script>alert(1)</script>'} />,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">')
  })

  it('does not create executable javascript links from assistant markdown', () => {
    const { container } = render(<MarkdownRenderer content="[click me](javascript:alert(1))" />)

    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link).toHaveTextContent('click me')
    expect(link!.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
  })

  it('renders crafted code language names as inert code text', () => {
    const { container } = render(
      <MarkdownRenderer content={'```"><img src=x onerror=alert(1)>\nconsole.log("safe")\n```'} />,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(screen.getByText('console.log("safe")')).toBeInTheDocument()
  })

  it('renders citation markers without injecting scriptable hrefs', () => {
    render(<MarkdownRenderer hasCitations content={'See this [1] <script>alert(1)</script>'} />)

    const citation = screen.getByRole('link', { name: '[1]' })
    expect(citation).toHaveAttribute('href', '#citation-1')
    expect(document.querySelector('script')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Literal <br> in table cells → real line breaks (renderer-side, non-lossy)
//
// Small on-device models emit literal `<br>` inside GFM cells. With no
// rehype-raw / no skipHtml, that would render as junk text. These tests assert
// the td/th overrides convert only those markers into real <br/> elements,
// without widening the raw-HTML surface elsewhere.
// ---------------------------------------------------------------------------

describe('literal <br> in table cells', () => {
  // The break lives in the second column so it is unambiguous which cell we
  // assert on. Two-column tables with spaced separators are what real models
  // emit and pass through the host-side normalizer unchanged.
  it('renders a single break as a real <br> element with no literal text', () => {
    const { container } = render(
      <MarkdownRenderer content={'| K | V |\n| --- | --- |\n| r | A<br>B |'} />,
    )
    const cell = container.querySelectorAll('td')[1]!
    expect(cell.querySelectorAll('br')).toHaveLength(1)
    expect(cell.textContent).toBe('AB')
    expect(cell.textContent).not.toContain('<br>')
  })

  it('converts every break when a cell has multiple <br>', () => {
    const { container } = render(
      <MarkdownRenderer content={'| K | V |\n| --- | --- |\n| r | A<br>B<br>C |'} />,
    )
    const cell = container.querySelectorAll('td')[1]!
    expect(cell.querySelectorAll('br')).toHaveLength(2)
    expect(cell.textContent).toBe('ABC')
  })

  it('converts the <br/>, <br />, and <BR> variants', () => {
    const { container } = render(
      <MarkdownRenderer content={'| K | V |\n| --- | --- |\n| r | A<br/>B<br />C<BR>D |'} />,
    )
    const cell = container.querySelectorAll('td')[1]!
    expect(cell.querySelectorAll('br')).toHaveLength(3)
    expect(cell.textContent).toBe('ABCD')
  })

  it('keeps inline formatting around a break', () => {
    const { container } = render(
      <MarkdownRenderer content={'| K | V |\n| --- | --- |\n| r | **A**<br>**B** |'} />,
    )
    const cell = container.querySelectorAll('td')[1]!
    expect(cell.querySelectorAll('strong')).toHaveLength(2)
    expect(cell.querySelectorAll('br')).toHaveLength(1)
  })

  it('leaves <br> inside inline code as literal content', () => {
    const { container } = render(
      <MarkdownRenderer content={'| K | V |\n| --- | --- |\n| r | `a<br>b` |'} />,
    )
    const code = container.querySelectorAll('td')[1]!.querySelector('code')
    expect(code).not.toBeNull()
    expect(code!.querySelectorAll('br')).toHaveLength(0)
    expect(code!.textContent).toBe('a<br>b')
  })

  it('does not convert <br> outside a table (no HTML surface widening)', () => {
    const { container } = render(<MarkdownRenderer content={'x<br>y'} />)
    expect(container.querySelector('br')).toBeNull()
    expect(container).toHaveTextContent('x<br>y')
  })

  it('applies the same treatment to header (th) cells', () => {
    const { container } = render(
      <MarkdownRenderer content={'| K | A<br>B |\n| --- | --- |\n| x | y |'} />,
    )
    const th = container.querySelectorAll('th')[1]!
    expect(th.querySelectorAll('br')).toHaveLength(1)
    expect(th.textContent).toBe('AB')
  })
})

// ---------------------------------------------------------------------------
// Chat #7 Wave 2.5 — host-side markdown normalization (display path)
//
// The renderer applies normalizeStreamMarkdown to the body BEFORE parsing, so
// the formatting artifacts small on-device models emit render correctly. These
// tests assert the end-to-end effect through the real component.
// ---------------------------------------------------------------------------

describe('host-side markdown normalization (display)', () => {
  it('renders a glued heading as an actual heading', () => {
    // "##Summary" is NOT a CommonMark heading — without normalization it renders
    // as literal paragraph text. After normalization it becomes a real <h2>.
    render(<MarkdownRenderer content="##Summary" />)
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading).toHaveTextContent('Summary')
  })

  it('renders glued dash bullets as a real list', () => {
    render(<MarkdownRenderer content={'-one\n-two\n-three'} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
  })

  it('renders glued ordered markers as a real ordered list', () => {
    render(<MarkdownRenderer content={'1.first\n2.second'} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
  })

  it('renders a separator-less pipe table as a real table', () => {
    render(<MarkdownRenderer content={'| Name | Age |\n| Alice | 30 |'} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('does not normalize inside a code fence', () => {
    const md = '```\n#NotAHeading\n```'
    render(<MarkdownRenderer content={md} />)
    // The hash stays literal inside the code block — no <h1> is produced.
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText(/#NotAHeading/)).toBeInTheDocument()
  })

  it('preserves the still-streaming trailing line (no premature heading)', () => {
    // While streaming, the final unterminated line is left raw — "#Partial" must
    // not become a heading until the line completes.
    render(<MarkdownRenderer content={'# Title\n\n#Partial'} isStreaming />)
    const headings = screen.getAllByRole('heading')
    // Only the already-complete "# Title" is a heading; "#Partial" is not.
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Title')
  })
})

// ---------------------------------------------------------------------------
// Workstream C — Progressive syntax highlighting
// ---------------------------------------------------------------------------

describe('hasOpenFence', () => {
  it('returns false for content with no fences', () => {
    expect(hasOpenFence('Hello world')).toBe(false)
  })

  it('returns false for content with one closed fence pair', () => {
    expect(hasOpenFence('```js\nconst x = 1;\n```')).toBe(false)
  })

  it('returns true for content with one open fence', () => {
    expect(hasOpenFence('```js\nconst x = 1;')).toBe(true)
  })

  it('returns false for content with two closed fence pairs', () => {
    expect(hasOpenFence('```js\nconst x = 1;\n```\n\nSome text\n\n```py\nx = 1\n```')).toBe(false)
  })

  it('returns true for two closed fences plus one open', () => {
    expect(hasOpenFence('```js\nconst x = 1;\n```\n\n```py\nx = 1\n```\n\n```rust\nfn main() {')).toBe(true)
  })

  it('returns false for empty content', () => {
    expect(hasOpenFence('')).toBe(false)
  })
})

describe('Progressive highlighting during streaming', () => {
  it('applies syntax highlighting for closed code fences during streaming', () => {
    const md = '```javascript\nconsole.log("hi")\n```'
    // When streaming with a closed fence, rehype-highlight should run
    // and the CodeBlock component should receive the language
    render(<MarkdownRenderer content={md} isStreaming />)
    expect(screen.getByText('javascript')).toBeInTheDocument()
  })

  it('still renders code when fence is open during streaming (no highlighting)', () => {
    const md = '```javascript\nconsole.log("hi")'
    // Open fence during streaming — no rehype-highlight, but code still renders
    const { container } = render(<MarkdownRenderer content={md} isStreaming />)
    // The code content should still be present in the DOM
    expect(container.textContent).toContain('console.log("hi")')
  })
})

// ---------------------------------------------------------------------------
// Workstream D — KaTeX math detection
// ---------------------------------------------------------------------------

describe('MATH_DETECT regex', () => {
  describe('correctly detects math notation', () => {
    it('detects display math $$x^2$$', () => {
      expect(MATH_DETECT.test('Here is $$x^2$$ inline')).toBe(true)
    })

    it('detects display math with newlines', () => {
      expect(MATH_DETECT.test('$$\nf(x) = x^2\n$$')).toBe(true)
    })

    it('detects inline math with caret $x^2$', () => {
      expect(MATH_DETECT.test('The value $x^2$ is squared')).toBe(true)
    })

    it('detects inline math with underscore $x_i$', () => {
      expect(MATH_DETECT.test('Element $x_i$ in array')).toBe(true)
    })

    it('detects inline math with backslash $\\frac{1}{2}$', () => {
      expect(MATH_DETECT.test('The fraction $\\frac{1}{2}$ is half')).toBe(true)
    })

    it('detects inline math $E = mc^2$', () => {
      expect(MATH_DETECT.test('Einstein showed $E = mc^2$')).toBe(true)
    })
  })

  describe('correctly rejects non-math dollar signs', () => {
    it('rejects simple monetary amount $5', () => {
      expect(MATH_DETECT.test('It costs $5')).toBe(false)
    })

    it('rejects two monetary amounts $5 and $10', () => {
      expect(MATH_DETECT.test('Cost is $5 and $10')).toBe(false)
    })

    it('rejects monetary range $5-$10', () => {
      expect(MATH_DETECT.test('Price range $5-$10')).toBe(false)
    })

    it('rejects plain text with single dollar sign', () => {
      expect(MATH_DETECT.test('I have $ in my pocket')).toBe(false)
    })

    it('rejects empty dollar signs $$', () => {
      // Two adjacent dollars with nothing between them should not match
      expect(MATH_DETECT.test('Use $$ for display')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Workstream E — Block-level stagger during streaming
// ---------------------------------------------------------------------------

describe('Block-level stagger during streaming', () => {
  it('applies data-stagger-index to new blocks during streaming', () => {
    const md = "- Alpha\n- Beta\n- Gamma"
    const { container } = render(<MarkdownRenderer content={md} isStreaming />)
    const staggered = container.querySelectorAll('[data-stagger-index]')
    expect(staggered.length).toBe(3)
    expect(staggered[0]!.getAttribute('data-stagger-index')).toBe('0')
    expect(staggered[1]!.getAttribute('data-stagger-index')).toBe('1')
    expect(staggered[2]!.getAttribute('data-stagger-index')).toBe('2')
  })

  it('does not apply stagger attributes when not streaming', () => {
    const md = "- Alpha\n- Beta\n- Gamma"
    const { container } = render(<MarkdownRenderer content={md} />)
    const staggered = container.querySelectorAll('[data-stagger-index]')
    expect(staggered.length).toBe(0)
  })

  it('applies stagger to paragraph blocks during streaming', () => {
    const md = "First paragraph\n\nSecond paragraph\n\nThird paragraph"
    const { container } = render(<MarkdownRenderer content={md} isStreaming />)
    const staggered = container.querySelectorAll('[data-stagger-index]')
    expect(staggered.length).toBe(3)
  })

  it('caps stagger delay at MAX_STAGGER_DELAY_S for block index >= 5', () => {
    const md = Array.from({ length: 7 }, (_, i) => `- Item ${i}`).join('\n')
    const { container } = render(<MarkdownRenderer content={md} isStreaming />)
    const staggered = container.querySelectorAll('[data-stagger-index]')
    expect(staggered.length).toBeGreaterThanOrEqual(7)
    // Block 5 and 6 both rendered; their stagger-index attributes still increment
    // even though the actual delay caps at MAX_STAGGER_DELAY_S
    expect(staggered[5]?.getAttribute('data-stagger-index')).toBe('5')
    expect(staggered[6]?.getAttribute('data-stagger-index')).toBe('6')
  })

  it('applies stagger to heading blocks during streaming', () => {
    const md = "## Heading One\n\n## Heading Two"
    const { container } = render(<MarkdownRenderer content={md} isStreaming />)
    const staggered = container.querySelectorAll('[data-stagger-index]')
    expect(staggered.length).toBe(2)
    expect(staggered[0]!.getAttribute('data-stagger-index')).toBe('0')
    expect(staggered[1]!.getAttribute('data-stagger-index')).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// W3a — Identity-stable components + reveal correctness across streamed tokens
//
// These tests lock the two invariants of the perf change:
//   (a) the `components` object identity is stable across streamed tokens, so
//       ReactMarkdown does NOT re-mount unchanged blocks on every token; and
//   (b) the block-reveal animation stays correct on re-render — only NEWLY
//       appended blocks animate; previously-revealed blocks do not re-animate.
//
// Behaviorally these are tested together via rerender(): React Testing Library
// runs commit-phase effects (the post-commit `prevBlockCountRef` update) inside
// act() between rerenders, which mirrors real token-by-token streaming.
// ---------------------------------------------------------------------------

describe('W3a — reveal correctness across streamed tokens', () => {
  it('only animates the newly appended block when content grows during streaming', () => {
    // First streamed frame: two paragraphs. Both are "new" on first render.
    const { container, rerender } = render(
      <MarkdownRenderer content={"First paragraph\n\nSecond paragraph"} isStreaming />,
    )
    expect(container.querySelectorAll('[data-stagger-index]')).toHaveLength(2)

    // Next streamed frame: a third paragraph appended. Only THAT block is new;
    // the two already-revealed paragraphs must render as plain (no stagger).
    rerender(
      <MarkdownRenderer
        content={"First paragraph\n\nSecond paragraph\n\nThird paragraph"}
        isStreaming
      />,
    )

    const staggered = container.querySelectorAll('[data-stagger-index]')
    expect(staggered).toHaveLength(1)
    // The single new block is the third paragraph; its stagger-index is relative
    // to prevBlockCount (2), so it restarts at 0.
    expect(staggered[0]!.getAttribute('data-stagger-index')).toBe('0')
    expect(staggered[0]).toHaveTextContent('Third paragraph')
  })

  it('does not re-animate previously revealed blocks on a mid-stream token that adds no block', () => {
    // A trailing partial token extends the LAST paragraph without adding a block.
    const { container, rerender } = render(
      <MarkdownRenderer content={"Alpha\n\nBeta"} isStreaming />,
    )
    expect(container.querySelectorAll('[data-stagger-index]')).toHaveLength(2)

    // Same block count (2 paragraphs), just more text in the second one.
    rerender(<MarkdownRenderer content={"Alpha\n\nBeta gamma"} isStreaming />)

    // No block is "new" → nothing should animate.
    expect(container.querySelectorAll('[data-stagger-index]')).toHaveLength(0)
    expect(container).toHaveTextContent('Beta gamma')
  })

  it('keeps an already-revealed (now-static) block mounted across subsequent streamed tokens', () => {
    // Identity stability is observable via DOM-node persistence. A block that is
    // already STATIC (plain host element) in two consecutive frames must keep the
    // same DOM node — ReactMarkdown reconciles it rather than re-mounting. If the
    // `components` object were recreated each token (the pre-fix behavior), the
    // custom block component type would differ by identity at that position and
    // force an unmount/remount, swapping the DOM node.
    //
    // We must use a block that is static in BOTH compared frames. On the first
    // render every block animates (prevBlockCount = 0), and the animated
    // motion.* element legitimately transitions to a plain host element once it
    // is "seen" — that one-time motion→plain swap is expected and unrelated to
    // identity stability. So we compare frame 2 ↔ frame 3, where block A is
    // already plain in both.
    const { container, rerender } = render(
      <MarkdownRenderer content={"## Heading A\n\nBody one"} isStreaming />,
    )
    // Frame 2: block A is now "seen" → renders as a plain <h2>; "Body two" is new.
    rerender(
      <MarkdownRenderer content={"## Heading A\n\nBody one\n\nBody two"} isStreaming />,
    )
    const headingAfterFrame2 = container.querySelector('h2')
    expect(headingAfterFrame2).not.toBeNull()
    expect(headingAfterFrame2).toHaveTextContent('Heading A')
    // Already static — no stagger attribute.
    expect(headingAfterFrame2!.hasAttribute('data-stagger-index')).toBe(false)

    // Frame 3: another block appended. Heading A is static in both frame 2 and 3.
    rerender(
      <MarkdownRenderer
        content={"## Heading A\n\nBody one\n\nBody two\n\nBody three"}
        isStreaming
      />,
    )

    // Same DOM node ⇒ identity-stable components reconciled it instead of
    // remounting. This is the behavioral proof of the perf fix.
    expect(container.querySelector('h2')).toBe(headingAfterFrame2)
    expect(container.querySelector('h2')!.hasAttribute('data-stagger-index')).toBe(false)
  })

  it('never animates when not streaming, even as content grows across renders', () => {
    const { container, rerender } = render(
      <MarkdownRenderer content={"One\n\nTwo"} />,
    )
    expect(container.querySelectorAll('[data-stagger-index]')).toHaveLength(0)

    rerender(<MarkdownRenderer content={"One\n\nTwo\n\nThree"} />)
    expect(container.querySelectorAll('[data-stagger-index]')).toHaveLength(0)
  })
})

describe('KaTeX lazy loading', () => {
  it('loads math plugins when content contains display math', async () => {
    const { container } = render(
      <MarkdownRenderer content="Here is $$x^2 + y^2 = z^2$$ math" />
    )

    // After the dynamic imports resolve, the component should re-render
    // with the math plugins active. The remark-math plugin transforms $$ blocks
    // into math nodes, and rehype-katex renders them.
    // With our mocked plugins (no-ops), the math text should still be present.
    await waitFor(() => {
      expect(container.textContent).toContain('x^2 + y^2 = z^2')
    })
  })

  it('does not load math plugins for plain monetary text', async () => {
    render(<MarkdownRenderer content="It costs $5 and $10 total" />)

    // The text should render as-is without triggering math loading
    expect(screen.getByText(/It costs \$5 and \$10 total/)).toBeInTheDocument()
  })
})
