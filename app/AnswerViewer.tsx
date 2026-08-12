"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export type SemanticNode = {
  content: string;
  children?: SemanticNode[];
};

export type SemanticAnswer = {
  version: 1;
  title: string;
  root: SemanticNode;
  terms?: Record<string, string>;
};

export type TranscriptSession = {
  id: string;
  title: string;
  temporary?: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  latestSequence: number;
  latestTurnId: string;
  turnCount: number;
};

export type TranscriptTurn = {
  id: string;
  sessionId: string;
  sequence: number;
  createdAt: string;
  requestSummary: string;
  answer: SemanticAnswer;
};

export type DemoTranscript = {
  sessions: TranscriptSession[];
  turns: TranscriptTurn[];
};

type TurnPage = {
  sessionId: string;
  turns: TranscriptTurn[];
  hasOlder: boolean;
  hasNewer: boolean;
  oldestSequence: number | null;
  latestSequence: number;
};

type StoredSessionState = {
  scrollTop: number;
  selectedTurnId: string | null;
  expandedByTurn: Record<string, string[]>;
  lastSeenSequence: number;
  anchorTurnId?: string | null;
  anchorSequence?: number | null;
  anchorOffset?: number;
};

type StoredTabState = Record<string, StoredSessionState>;
type SyncState = "file" | "connecting" | "live" | "offline";
type CopyState = "visible" | "complete" | "error" | null;
type OpenTerm = {
  instanceId: string;
  turnId: string;
  termId: string;
  trigger: HTMLButtonElement;
  left: number;
  bottom: number;
} | null;

const DEFAULT_API_BASE = "http://127.0.0.1:4318";
const API_BASE =
  process.env.NEXT_PUBLIC_SEMANTIC_ANSWER_API?.replace(/\/+$/, "") ||
  DEFAULT_API_BASE;
const TAB_STATE_KEY = "semantic-transcript-reader-v1";
const PAGE_SIZE = 20;
const MAX_RENDERED_TURNS = 80;
const CONTIGUOUS_WINDOW_LIMIT = MAX_RENDERED_TURNS - 1;
const FOLLOW_DISTANCE = 140;
const SEMANTIC_SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "term"],
  },
};
const TOP_LEVEL_FIELDS = new Set(["version", "title", "root", "terms"]);
const NODE_FIELDS = new Set(["content", "children"]);
const TERM_ID_PATTERN = /^[a-z0-9._-]+$/;
const MAX_DEPTH = 12;
const MAX_NODES = 1_000;

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function pathKey(path: number[]): string {
  return path.join("-");
}

function nodePath(path: number[]): string {
  return path.length ? pathKey(path) : "root";
}

function branchLabel(path: number[]): string {
  return path.map((part) => part + 1).join(".");
}

function markdownOutsideCode(markdown: string): string {
  const lines = markdown.split("\n");
  const visibleLines: string[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      const closing = new RegExp(`^ {0,3}${marker}{${fence[1].length},}\\s*$`);
      while (lineIndex + 1 < lines.length && !closing.test(lines[lineIndex + 1])) {
        lineIndex += 1;
      }
      if (lineIndex + 1 < lines.length) lineIndex += 1;
      visibleLines.push("");
      continue;
    }

    let visible = "";
    for (let index = 0; index < line.length; ) {
      if (line[index] !== "`") {
        visible += line[index];
        index += 1;
        continue;
      }
      let width = 1;
      while (line[index + width] === "`") width += 1;
      const delimiter = "`".repeat(width);
      const closeIndex = line.indexOf(delimiter, index + width);
      if (closeIndex === -1) {
        visible += line.slice(index);
        break;
      }
      visible += " ".repeat(closeIndex + width - index);
      index = closeIndex + width;
    }
    visibleLines.push(visible);
  }

  return visibleLines.join("\n");
}

function termReferences(markdown: string): string[] {
  return Array.from(
    markdownOutsideCode(markdown).matchAll(
      /\]\(\s*<?term:([^\s)>]*)>?\s*(?:["'][^"']*["']\s*)?\)/g,
    ),
    (match) => match[1],
  );
}

function isNode(
  value: unknown,
  state: { nodes: number; references: string[] },
  depth: number,
): value is SemanticNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  state.nodes += 1;
  if (
    depth > MAX_DEPTH ||
    state.nodes > MAX_NODES ||
    !hasOnlyKeys(node, NODE_FIELDS) ||
    !owns(node, "content") ||
    typeof node.content !== "string" ||
    node.content.trim().length === 0 ||
    new TextEncoder().encode(node.content).byteLength > 256 * 1_024
  ) {
    return false;
  }
  state.references.push(...termReferences(node.content));
  return (
    node.children === undefined ||
    (Array.isArray(node.children) &&
      node.children.every((child) => isNode(child, state, depth + 1)))
  );
}

function isAnswer(value: unknown): value is SemanticAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  const state = { nodes: 0, references: [] as string[] };
  if (
    !hasOnlyKeys(answer, TOP_LEVEL_FIELDS) ||
    answer.version !== 1 ||
    typeof answer.title !== "string" ||
    !isNode(answer.root, state, 0)
  ) {
    return false;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1_024 * 1_024) {
    return false;
  }
  if (
    answer.terms !== undefined &&
    (!answer.terms || typeof answer.terms !== "object" || Array.isArray(answer.terms))
  ) {
    return false;
  }
  const terms = (answer.terms ?? {}) as Record<string, unknown>;
  const entries = Object.entries(terms);
  if (
    entries.length > 500 ||
    entries.some(
      ([termId, definition]) =>
        !TERM_ID_PATTERN.test(termId) ||
        termId.length > 128 ||
        typeof definition !== "string" ||
        new TextEncoder().encode(definition).byteLength > 64 * 1_024,
    )
  ) {
    return false;
  }
  return state.references.every(
    (termId) => TERM_ID_PATTERN.test(termId) && owns(terms, termId),
  );
}

function isTurn(value: unknown): value is TranscriptTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.id === "string" &&
    typeof turn.sessionId === "string" &&
    Number.isSafeInteger(turn.sequence) &&
    (turn.sequence as number) > 0 &&
    typeof turn.createdAt === "string" &&
    typeof turn.requestSummary === "string" &&
    isAnswer(turn.answer)
  );
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function expandablePaths(root: SemanticNode): Set<string> {
  const result = new Set<string>();
  const visit = (node: SemanticNode, path: number[]) => {
    if (path.length && node.children?.length) result.add(pathKey(path));
    node.children?.forEach((child, index) => visit(child, [...path, index]));
  };
  visit(root, []);
  return result;
}

function copyText(answer: SemanticAnswer, expanded: Set<string>, complete: boolean): string {
  const passages: string[] = [];
  const referencedTerms: string[] = [];
  const seenTerms = new Set<string>();
  const visit = (node: SemanticNode, path: number[]) => {
    if (node.content.trim()) passages.push(node.content.trim());
    if (complete) {
      for (const termId of termReferences(node.content)) {
        if (!seenTerms.has(termId)) {
          seenTerms.add(termId);
          referencedTerms.push(termId);
        }
      }
    }
    if (complete || path.length === 0 || expanded.has(pathKey(path))) {
      node.children?.forEach((child, index) => visit(child, [...path, index]));
    }
  };
  visit(answer.root, []);
  const glossary = referencedTerms.flatMap((termId) =>
    answer.terms && owns(answer.terms, termId)
      ? [`${termId}: ${answer.terms[termId]}`]
      : [],
  );
  if (complete && glossary.length > 0) {
    passages.push(
      "Terms",
      ...glossary,
    );
  }
  return [answer.title.trim(), ...passages].join("\n\n");
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const success = document.execCommand("copy");
  field.remove();
  if (!success) throw new Error("Clipboard unavailable");
}

function safeUrl(url: string): string {
  return url.startsWith("term:") ? url : defaultUrlTransform(url);
}

function readTabState(): StoredTabState {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(TAB_STATE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as StoredTabState)
      : {};
  } catch {
    return {};
  }
}

function writeTabState(value: StoredTabState): void {
  try {
    sessionStorage.setItem(TAB_STATE_KEY, JSON.stringify(value));
  } catch {
    // Reader state is an enhancement; storage may be disabled.
  }
}

function formatTurnDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Filed turn";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function mergeTurns(current: TranscriptTurn[], incoming: TranscriptTurn[]): TranscriptTurn[] {
  const byId = new Map(current.map((turn) => [turn.id, turn]));
  incoming.forEach((turn) => byId.set(turn.id, turn));
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function largestContiguousRun(turns: TranscriptTurn[]): TranscriptTurn[] {
  if (turns.length === 0) return [];
  const ordered = [...turns].sort((left, right) => left.sequence - right.sequence);
  let best: TranscriptTurn[] = [];
  let current: TranscriptTurn[] = [];
  for (const turn of ordered) {
    if (current.length === 0 || turn.sequence === current.at(-1)!.sequence + 1) {
      current.push(turn);
    } else {
      const currentEnd = current.at(-1)?.sequence ?? 0;
      const bestEnd = best.at(-1)?.sequence ?? 0;
      if (current.length > best.length || (current.length === best.length && currentEnd > bestEnd)) {
        best = current;
      }
      current = [turn];
    }
  }
  const currentEnd = current.at(-1)?.sequence ?? 0;
  const bestEnd = best.at(-1)?.sequence ?? 0;
  if (current.length > best.length || (current.length === best.length && currentEnd > bestEnd)) {
    best = current;
  }
  return best;
}

function boundTurnWindow(
  turns: TranscriptTurn[],
  direction: "older" | "newer",
  selectedTurnId: string | null,
): TranscriptTurn[] {
  const ordered = mergeTurns([], turns);
  if (ordered.length <= MAX_RENDERED_TURNS) return ordered;
  const run = largestContiguousRun(ordered);
  const contiguous = direction === "older"
    ? run.slice(0, CONTIGUOUS_WINDOW_LIMIT)
    : run.slice(-CONTIGUOUS_WINDOW_LIMIT);
  const selected = selectedTurnId
    ? ordered.find((turn) => turn.id === selectedTurnId)
    : undefined;
  if (selected && !contiguous.some((turn) => turn.id === selected.id)) {
    contiguous.push(selected);
  }
  return contiguous.sort((left, right) => left.sequence - right.sequence);
}

function contiguousWindowRange(turns: TranscriptTurn[]): {
  firstSequence: number;
  lastSequence: number;
} | null {
  const run = largestContiguousRun(turns);
  if (run.length === 0) return null;
  return {
    firstSequence: run[0].sequence,
    lastSequence: run.at(-1)!.sequence,
  };
}

function visibleTurnAnchor(scroller: HTMLDivElement | null): {
  turnId: string;
  sequence: number;
  offset: number;
} | null {
  if (!scroller) return null;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const element = [...scroller.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
    (candidate) => candidate.getBoundingClientRect().bottom > scrollerTop + 1,
  );
  const turnId = element?.dataset.turnId;
  const sequence = Number(element?.dataset.sequence);
  if (!element || !turnId || !Number.isSafeInteger(sequence)) return null;
  return {
    turnId,
    sequence,
    offset: element.getBoundingClientRect().top - scrollerTop,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return (await response.json()) as T;
}

function TermLink({
  href,
  instanceId,
  turnId,
  children,
  openTerm,
  setOpenTerm,
}: {
  href: string;
  instanceId: string;
  turnId: string;
  children: ReactNode;
  openTerm: OpenTerm;
  setOpenTerm: (term: OpenTerm) => void;
}) {
  let termId = href.slice(5);
  try {
    termId = decodeURIComponent(termId);
  } catch {
    // Preserve a malformed-but-readable identifier.
  }
  const stableTurn = sanitize(turnId);
  const stableId = sanitize(termId);
  const popoverId = `term-popover-${stableTurn}-${sanitize(instanceId)}`;
  const open = openTerm?.instanceId === instanceId && openTerm.turnId === turnId;

  return (
    <span className="term-anchor">
      <button
        type="button"
        className="term-trigger"
        data-term-trigger
        data-term-id={termId}
        data-testid={`term-${stableTurn}-${stableId}`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={(event) => {
          if (open) {
            setOpenTerm(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setOpenTerm({
            instanceId,
            turnId,
            termId,
            trigger: event.currentTarget,
            left: Math.min(window.innerWidth - 196, Math.max(196, rect.left + rect.width / 2)),
            bottom: window.innerHeight - rect.top + 12,
          });
        }}
      >
        {children}
      </button>
    </span>
  );
}

function Markdown({
  content,
  turnId,
  openTerm,
  setOpenTerm,
  allowTerms = true,
  scope = "content",
}: {
  content: string;
  turnId: string;
  openTerm: OpenTerm;
  setOpenTerm: (term: OpenTerm) => void;
  allowTerms?: boolean;
  scope?: string;
}) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeSanitize, SEMANTIC_SANITIZE_SCHEMA],
          [rehypeKatex, { throwOnError: false, strict: false }],
        ]}
        skipHtml
        urlTransform={safeUrl}
        components={{
          a: ({ node, href = "", children, title }) => {
            if (href.startsWith("term:")) {
              if (!allowTerms) return <>{children}</>;
              return (
                <TermLink
                  href={href}
                  instanceId={`${scope}-${node?.position?.start.offset ?? href}`}
                  turnId={turnId}
                  openTerm={openTerm}
                  setOpenTerm={setOpenTerm}
                >
                  {children}
                </TermLink>
              );
            }
            const external = /^https?:\/\//i.test(href);
            return (
              <a
                href={href}
                title={title}
                className={external ? "external-link" : undefined}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
              >
                {children}
              </a>
            );
          },
          img: ({ alt }) => (
            <span
              className="markdown-image-omitted"
              role="note"
              data-testid={`image-omitted-${sanitize(turnId)}-${sanitize(scope)}`}
            >
              Image not loaded{alt ? `: ${alt}` : ""}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function TermPopover({
  openTerm,
  terms,
  onClose,
}: {
  openTerm: NonNullable<OpenTerm>;
  terms: Record<string, string>;
  onClose: () => void;
}) {
  const popoverId = `term-popover-${sanitize(openTerm.turnId)}-${sanitize(openTerm.instanceId)}`;
  const definition = terms[openTerm.termId] ?? "No definition is included in this turn.";

  return (
    <aside
      id={popoverId}
      className="term-popover"
      data-term-popover
      data-testid={`term-popover-${sanitize(openTerm.turnId)}`}
      role="note"
      aria-label={`${openTerm.termId} definition`}
      style={{ left: openTerm.left, bottom: openTerm.bottom }}
    >
      <span className="term-kicker">In this turn</span>
      <div className="term-definition">
        <Markdown
          content={definition}
          turnId={openTerm.turnId}
          openTerm={null}
          setOpenTerm={() => undefined}
          allowTerms={false}
          scope="term-definition"
        />
      </div>
      <button type="button" className="term-close" aria-label="Close definition" onClick={onClose}>
        Close
      </button>
    </aside>
  );
}

function AnswerNode({
  node,
  path,
  turnId,
  frontier,
  expanded,
  toggle,
  openTerm,
  setOpenTerm,
}: {
  node: SemanticNode;
  path: number[];
  turnId: string;
  frontier: boolean;
  expanded: Set<string>;
  toggle: (path: string) => void;
  openTerm: OpenTerm;
  setOpenTerm: (term: OpenTerm) => void;
}) {
  const root = path.length === 0;
  const testPath = nodePath(path);
  const scopedPath = `${sanitize(turnId)}-${testPath}`;
  const key = pathKey(path);
  const count = node.children?.length ?? 0;
  const hasChildren = count > 0;
  const open = root ? frontier : expanded.has(key);
  const childrenId = `children-${scopedPath}`;

  return (
    <section
      className={`answer-node ${root ? "root-node" : "branch-node"}`}
      data-node-path={testPath}
      data-testid={`node-${scopedPath}`}
      aria-label={root ? "Root answer" : `Answer branch ${branchLabel(path)}`}
      style={{ "--tree-depth": path.length } as CSSProperties}
    >
      <div className="node-paper">
        <div className="node-meta">
          <span className="node-label">{root ? "Core answer" : `Branch ${branchLabel(path)}`}</span>
          {!root && hasChildren ? (
            <button
              type="button"
              className="disclosure"
              data-disclosure-path={testPath}
              data-testid={`disclosure-${scopedPath}`}
              aria-expanded={open}
              aria-controls={childrenId}
              onClick={() => toggle(key)}
            >
              <span>{open ? "Collapse" : "Explore"}</span>
              <span className="disclosure-count">
                {count} {count === 1 ? "branch" : "branches"}
              </span>
              <span className="chevron" aria-hidden="true" />
            </button>
          ) : !root ? (
            <span className="node-leaf">End note</span>
          ) : (
            <span className="root-open">
              <span aria-hidden="true" /> {frontier ? "Frontier open" : "Select to explore"}
            </span>
          )}
        </div>
        <div data-root-content={root ? turnId : undefined} data-testid={root ? `root-content-${sanitize(turnId)}` : undefined}>
          <Markdown
            content={node.content}
            turnId={turnId}
            openTerm={openTerm}
            setOpenTerm={setOpenTerm}
            scope={`${scopedPath}-content`}
          />
        </div>
      </div>

      {hasChildren && open ? (
        <div id={childrenId} className={`node-children ${root ? "root-children" : "nested-children"}`}>
          {node.children?.map((child, index) => (
            <AnswerNode
              key={`${scopedPath}-${index}`}
              node={child}
              path={[...path, index]}
              turnId={turnId}
              frontier={frontier}
              expanded={expanded}
              toggle={toggle}
              openTerm={openTerm}
              setOpenTerm={setOpenTerm}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TurnCard({
  turn,
  latest,
  selected,
  expanded,
  copyState,
  openTerm,
  onSelect,
  onToggle,
  onExpandAll,
  onCollapseAll,
  onCopy,
  setOpenTerm,
}: {
  turn: TranscriptTurn;
  latest: boolean;
  selected: boolean;
  expanded: Set<string>;
  copyState: CopyState;
  openTerm: OpenTerm;
  onSelect: () => void;
  onToggle: (path: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onCopy: (complete: boolean) => void;
  setOpenTerm: (term: OpenTerm) => void;
}) {
  const allExpandable = useMemo(() => expandablePaths(turn.answer.root), [turn.answer.root]);
  const frontier = latest || selected;
  const stableTurn = sanitize(turn.id);
  const copyMessage =
    copyState === "visible"
      ? "Visible answer copied"
      : copyState === "complete"
        ? "Complete answer copied"
        : copyState === "error"
          ? "Copy was not available"
          : "";

  return (
    <article
      className={`turn-card${selected ? " turn-selected" : ""}${latest ? " turn-latest" : ""}`}
      data-testid={`turn-${stableTurn}`}
      data-turn-id={turn.id}
      data-sequence={turn.sequence}
      data-selected={selected ? "true" : "false"}
      aria-labelledby={`turn-title-${stableTurn}`}
    >
      <header className="turn-heading">
        <div className="turn-order">
          <span>Turn {turn.sequence}</span>
          {latest ? <span className="latest-badge">Latest</span> : null}
          <time dateTime={turn.createdAt}>{formatTurnDate(turn.createdAt)}</time>
        </div>
        <p className="request-label">Request</p>
        <p className="request-summary" data-testid={`turn-summary-${stableTurn}`}>
          {turn.requestSummary}
        </p>
        <div className="turn-title-line">
          <h2 id={`turn-title-${stableTurn}`} data-testid={`turn-title-${stableTurn}`}>{turn.answer.title}</h2>
          {!selected ? (
            <button type="button" className="select-turn" onClick={(event) => { event.stopPropagation(); onSelect(); }}>
              Read this turn
            </button>
          ) : (
            <span className="selected-label">Selected turn</span>
          )}
        </div>
      </header>

      {selected ? (
        <div className="reader-toolbar" aria-label={`Turn ${turn.sequence} controls`}>
          <div className="toolbar-intro">
            <span className="toolbar-kicker">Reading tree</span>
            <span>Controls apply only to this turn</span>
          </div>
          <div className="toolbar-actions">
            <button type="button" data-testid="expand-all" onClick={onExpandAll} disabled={allExpandable.size === 0}>
              Expand all
            </button>
            <button type="button" data-testid="collapse-all" onClick={onCollapseAll} disabled={expanded.size === 0}>
              Collapse all
            </button>
            <span className="toolbar-divider" aria-hidden="true" />
            <button type="button" data-testid="copy-visible" onClick={() => onCopy(false)}>
              Copy visible
            </button>
            <button type="button" data-testid="copy-complete" onClick={() => onCopy(true)}>
              Copy complete
            </button>
          </div>
          <span className="copy-status" role="status" aria-live="polite">{copyMessage}</span>
        </div>
      ) : null}

      <div className={`answer-tree${frontier ? "" : " answer-root-only"}`} data-testid={`turn-answer-${stableTurn}`}>
        <AnswerNode
          node={turn.answer.root}
          path={[]}
          turnId={turn.id}
          frontier={frontier}
          expanded={expanded}
          toggle={onToggle}
          openTerm={openTerm}
          setOpenTerm={setOpenTerm}
        />
      </div>
    </article>
  );
}

export function AnswerViewer({ initialTranscript }: { initialTranscript: DemoTranscript }) {
  const initialSession = initialTranscript.sessions[0] ?? null;
  const initialTurns = initialSession
    ? initialTranscript.turns.filter((turn) => turn.sessionId === initialSession.id).slice(-PAGE_SIZE)
    : [];
  const [sessions, setSessions] = useState<TranscriptSession[]>(initialTranscript.sessions);
  const [activeSessionId, setActiveSessionId] = useState(initialSession?.id ?? "");
  const [turns, setTurns] = useState<TranscriptTurn[]>(initialTurns);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(initialTurns.at(-1)?.id ?? null);
  const [expandedByTurn, setExpandedByTurn] = useState<Record<string, Set<string>>>({});
  const [unreadBySession, setUnreadBySession] = useState<Record<string, number>>({});
  const [hasOlder, setHasOlder] = useState(initialSession ? initialSession.turnCount > initialTurns.length : false);
  const [hasNewer, setHasNewer] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("file");
  const [copyState, setCopyState] = useState<CopyState>(null);
  const [loadingDirection, setLoadingDirection] = useState<"older" | "newer" | "latest" | null>(null);
  const [pendingLatest, setPendingLatest] = useState(0);
  const [openTerm, setOpenTerm] = useState<OpenTerm>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistFrame = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const localMode = useRef(false);
  const activeSessionRef = useRef(activeSessionId);
  const selectedTurnRef = useRef(selectedTurnId);
  const turnsRef = useRef(turns);
  const sessionsRef = useRef(sessions);
  const hasNewerRef = useRef(hasNewer);
  const expandedByTurnRef = useRef(expandedByTurn);
  const followedSequenceRef = useRef(0);
  const userScrollIntentRef = useRef(0);
  const anchorCorrectionTokenRef = useRef(0);
  const anchorCorrectionActiveRef = useRef(false);
  const anchorCorrectionScrollBehaviorRef = useRef<string | null>(null);
  const pendingScrollAnchorRef = useRef<{
    turnId: string;
    offset: number;
    previousHeight: number;
  } | null>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId) ?? turns.at(-1) ?? null;

  useEffect(() => { activeSessionRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { selectedTurnRef.current = selectedTurnId; }, [selectedTurnId]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { hasNewerRef.current = hasNewer; }, [hasNewer]);

  useLayoutEffect(() => {
    const pending = pendingScrollAnchorRef.current;
    const scroller = scrollRef.current;
    if (!pending || !scroller) return;
    const anchor = [...scroller.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
      (element) => element.dataset.turnId === pending.turnId,
    );
    if (anchor) {
      const nextOffset = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += nextOffset - pending.offset;
    } else {
      scroller.scrollTop += scroller.scrollHeight - pending.previousHeight;
    }
    pendingScrollAnchorRef.current = null;
  }, [turns]);

  const persistSessionState = useCallback((sessionId = activeSessionRef.current) => {
    if (!sessionId) return;
    const stored = readTabState();
    const current = stored[sessionId];
    const expanded: Record<string, string[]> = { ...(current?.expandedByTurn ?? {}) };
    for (const turn of turnsRef.current) {
      const paths = expandedByTurnRef.current[turn.id];
      if (paths?.size) expanded[turn.id] = [...paths];
      else delete expanded[turn.id];
    }
    const anchor = visibleTurnAnchor(scrollRef.current);
    stored[sessionId] = {
      scrollTop: scrollRef.current?.scrollTop ?? current?.scrollTop ?? 0,
      selectedTurnId: selectedTurnRef.current,
      expandedByTurn: expanded,
      lastSeenSequence: current?.lastSeenSequence ?? 0,
      anchorTurnId: anchor?.turnId ?? current?.anchorTurnId ?? null,
      anchorSequence: anchor?.sequence ?? current?.anchorSequence ?? null,
      anchorOffset: anchor?.offset ?? current?.anchorOffset ?? 0,
    };
    writeTabState(stored);
  }, []);

  const markSeen = useCallback((sessionId: string, sequence: number) => {
    const stored = readTabState();
    const prior = stored[sessionId];
    stored[sessionId] = {
      ...prior,
      scrollTop: scrollRef.current?.scrollTop ?? prior?.scrollTop ?? 0,
      selectedTurnId: selectedTurnRef.current,
      expandedByTurn: prior?.expandedByTurn ?? {},
      lastSeenSequence: Math.max(prior?.lastSeenSequence ?? 0, sequence),
    };
    writeTabState(stored);
    setUnreadBySession((current) => ({ ...current, [sessionId]: 0 }));
  }, []);

  const updateUrl = useCallback((sessionId: string, turnId: string | null, push: boolean) => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", sessionId);
    if (turnId) url.searchParams.set("turn", turnId);
    else url.searchParams.delete("turn");
    window.history[push ? "pushState" : "replaceState"]({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const applyStoredExpansions = useCallback((stored: StoredSessionState | undefined) => {
    if (!stored) return;
    const next = { ...expandedByTurnRef.current };
    for (const [turnId, paths] of Object.entries(stored.expandedByTurn ?? {})) {
      next[turnId] = new Set(paths);
    }
    expandedByTurnRef.current = next;
    setExpandedByTurn(next);
  }, []);

  const restoreScroll = useCallback((
    stored: StoredSessionState | undefined,
    forceBottom: boolean,
    latestSequence: number,
    focusTurnId: string | null,
  ) => {
    const sessionId = activeSessionRef.current;
    const generation = requestSequence.current;
    const userIntent = userScrollIntentRef.current;
    const existingScroller = scrollRef.current;
    if (existingScroller && anchorCorrectionScrollBehaviorRef.current !== null) {
      existingScroller.style.scrollBehavior = anchorCorrectionScrollBehaviorRef.current;
      anchorCorrectionScrollBehaviorRef.current = null;
    }
    const token = ++anchorCorrectionTokenRef.current;
    anchorCorrectionActiveRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) {
        if (anchorCorrectionTokenRef.current === token) {
          anchorCorrectionActiveRef.current = false;
        }
        return;
      }
      if (
        anchorCorrectionTokenRef.current !== token ||
        requestSequence.current !== generation ||
        activeSessionRef.current !== sessionId ||
        userScrollIntentRef.current !== userIntent
      ) {
        if (anchorCorrectionTokenRef.current === token) {
          anchorCorrectionActiveRef.current = false;
        }
        return;
      }
      const previousScrollBehavior = scroller.style.scrollBehavior;
      anchorCorrectionScrollBehaviorRef.current = previousScrollBehavior;
      scroller.style.scrollBehavior = "auto";
      const restoreScrollBehavior = () => {
        if (anchorCorrectionTokenRef.current !== token) return;
        scroller.style.scrollBehavior = previousScrollBehavior;
        anchorCorrectionScrollBehaviorRef.current = null;
      };
      const targetTurnId = focusTurnId ?? stored?.anchorTurnId ?? null;
      const targetOffset = focusTurnId ? 24 : stored?.anchorOffset ?? 0;
      const restoreAbsolute = !forceBottom && !targetTurnId && Boolean(stored?.selectedTurnId);
      if (restoreAbsolute) scroller.scrollTop = stored?.scrollTop ?? 0;

      let frame = 0;
      let stableFrames = 0;
      const finish = () => {
        if (anchorCorrectionTokenRef.current !== token) return;
        anchorCorrectionActiveRef.current = false;
        restoreScrollBehavior();
        persistSessionState();
        if (
          forceBottom ||
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_DISTANCE
        ) {
          markSeen(sessionId, latestSequence);
        }
      };
      const correct = () => {
        if (
          anchorCorrectionTokenRef.current !== token ||
          requestSequence.current !== generation ||
          activeSessionRef.current !== sessionId ||
          userScrollIntentRef.current !== userIntent
        ) {
          if (anchorCorrectionTokenRef.current === token) {
            anchorCorrectionActiveRef.current = false;
            restoreScrollBehavior();
          }
          return;
        }

        let delta = 0;
        let measurable = true;
        if (forceBottom || (!targetTurnId && !restoreAbsolute)) {
          delta = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        } else if (targetTurnId) {
          const target = [...scroller.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
            (element) => element.dataset.turnId === targetTurnId,
          );
          if (target) {
            delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - targetOffset;
          } else {
            measurable = false;
          }
        }

        if (measurable && Math.abs(delta) > 1) {
          scroller.scrollTop += delta;
          stableFrames = 0;
        } else if (measurable) {
          stableFrames += 1;
        }
        frame += 1;
        if (frame >= 12 || stableFrames >= 3) {
          finish();
          return;
        }
        requestAnimationFrame(correct);
      };
      correct();
    }));
  }, [markSeen, persistSessionState]);

  const loadTurnById = useCallback(async (turnId: string): Promise<TranscriptTurn | null> => {
    if (!localMode.current) {
      return initialTranscript.turns.find((turn) => turn.id === turnId) ?? null;
    }
    try {
      const payload = await getJson<{ turn: unknown }>(`${API_BASE}/api/turns/${encodeURIComponent(turnId)}?detail=full`);
      return isTurn(payload.turn) ? payload.turn : null;
    } catch {
      return null;
    }
  }, [initialTranscript.turns]);

  const openSession = useCallback(async (
    sessionId: string,
    requestedTurnId: string | null,
    push = true,
    saveCurrent = true,
    forceBottom = false,
  ) => {
    if (!sessionId) {
      ++requestSequence.current;
      pendingScrollAnchorRef.current = null;
      followedSequenceRef.current = 0;
      activeSessionRef.current = "";
      selectedTurnRef.current = null;
      turnsRef.current = [];
      expandedByTurnRef.current = {};
      hasNewerRef.current = false;
      setActiveSessionId("");
      setTurns([]);
      setSelectedTurnId(null);
      setExpandedByTurn({});
      setUnreadBySession({});
      setHasOlder(false);
      setHasNewer(false);
      setLoadingDirection(null);
      setPendingLatest(0);
      setOpenTerm(null);
      setCopyState(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("session");
      url.searchParams.delete("turn");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      return;
    }
    if (saveCurrent) persistSessionState();
    pendingScrollAnchorRef.current = null;
    followedSequenceRef.current = 0;
    const request = ++requestSequence.current;
    activeSessionRef.current = sessionId;
    setActiveSessionId(sessionId);
    setSidebarOpen(false);
    setOpenTerm(null);
    setCopyState(null);
    setPendingLatest(0);
    setLoadingDirection("latest");
    const stored = readTabState()[sessionId];
    applyStoredExpansions(stored);

    try {
      const fetchPage = async (beforeSequence?: number): Promise<TurnPage> => {
        if (localMode.current) {
          const cursor = beforeSequence === undefined ? "" : `&beforeSequence=${beforeSequence}`;
          return getJson<TurnPage>(
            `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns?limit=${PAGE_SIZE}&detail=full${cursor}`,
          );
        }
        const all = initialTranscript.turns.filter((turn) => turn.sessionId === sessionId);
        const eligible = beforeSequence === undefined
          ? all
          : all.filter((turn) => turn.sequence < beforeSequence);
        const pageTurns = eligible.slice(-PAGE_SIZE);
        return {
          sessionId,
          turns: pageTurns,
          hasOlder: (pageTurns[0]?.sequence ?? 1) > 1,
          hasNewer: (pageTurns.at(-1)?.sequence ?? 0) < (all.at(-1)?.sequence ?? 0),
          oldestSequence: pageTurns[0]?.sequence ?? null,
          latestSequence: all.at(-1)?.sequence ?? 0,
        };
      };

      const latestPage = await fetchPage();
      let page = latestPage;
      if (request !== requestSequence.current || page.sessionId !== sessionId) return;
      const latestTurns = latestPage.turns.filter(isTurn).sort((a, b) => a.sequence - b.sequence);
      let validTurns = latestTurns;
      let chosen = requestedTurnId ?? stored?.selectedTurnId ?? validTurns.at(-1)?.id ?? null;
      let chosenTurn = chosen ? validTurns.find((turn) => turn.id === chosen) : undefined;
      if (chosen && !validTurns.some((turn) => turn.id === chosen)) {
        const requested = await loadTurnById(chosen);
        if (requested?.sessionId === sessionId) chosenTurn = requested;
        else chosen = validTurns.at(-1)?.id ?? null;
      }
      if (request !== requestSequence.current || activeSessionRef.current !== sessionId) return;

      const latestRange = contiguousWindowRange(latestTurns);
      const targetOutsideLatest = chosenTurn && latestRange
        ? chosenTurn.sequence < latestRange.firstSequence || chosenTurn.sequence > latestRange.lastSequence
        : false;
      const anchorOutsideLatest = stored?.anchorSequence && latestRange
        ? stored.anchorSequence < latestRange.firstSequence || stored.anchorSequence > latestRange.lastSequence
        : false;
      let beforeSequence: number | undefined;
      if (requestedTurnId && targetOutsideLatest && chosenTurn) {
        beforeSequence = chosenTurn.sequence + 1;
      } else if (anchorOutsideLatest && stored?.anchorSequence) {
        beforeSequence = Math.min(
          latestPage.latestSequence + 1,
          stored.anchorSequence + Math.ceil(PAGE_SIZE / 2),
        );
      } else if (targetOutsideLatest && chosenTurn) {
        beforeSequence = chosenTurn.sequence + 1;
      }

      if (beforeSequence !== undefined) {
        page = await fetchPage(beforeSequence);
        if (request !== requestSequence.current || activeSessionRef.current !== sessionId) return;
        validTurns = page.turns.filter(isTurn).sort((a, b) => a.sequence - b.sequence);
      }
      if (chosenTurn && !validTurns.some((turn) => turn.id === chosenTurn.id)) {
        validTurns = mergeTurns(validTurns, [chosenTurn]);
      }
      const range = contiguousWindowRange(validTurns);
      setTurns(validTurns);
      turnsRef.current = validTurns;
      setSelectedTurnId(chosen);
      selectedTurnRef.current = chosen;
      setHasOlder((range?.firstSequence ?? 1) > 1);
      setHasNewer((range?.lastSequence ?? 0) < page.latestSequence);
      setLoadingDirection(null);
      updateUrl(sessionId, chosen, push);
      const focusRequestedTurn = requestedTurnId &&
        (!stored?.anchorTurnId || requestedTurnId !== stored.selectedTurnId)
        ? requestedTurnId
        : null;
      restoreScroll(stored, forceBottom, page.latestSequence, focusRequestedTurn);
    } catch {
      if (request !== requestSequence.current) return;
      setLoadingDirection(null);
      setSyncState("offline");
    }
  }, [applyStoredExpansions, initialTranscript.turns, loadTurnById, persistSessionState, restoreScroll, updateUrl]);

  const refreshSessions = useCallback(async (): Promise<TranscriptSession[]> => {
    if (!localMode.current) return initialTranscript.sessions;
    const payload = await getJson<{ sessions: TranscriptSession[] }>(`${API_BASE}/api/sessions`);
    const next = Array.isArray(payload.sessions) ? payload.sessions : [];
    sessionsRef.current = next;
    setSessions(next);
    const stored = readTabState();
    setUnreadBySession((current) => {
      const unread = { ...current };
      for (const session of next) {
        if (session.id === activeSessionRef.current) continue;
        unread[session.id] = Math.max(0, session.latestSequence - (stored[session.id]?.lastSeenSequence ?? 0));
      }
      return unread;
    });
    return next;
  }, [initialTranscript.sessions]);

  const selectTurn = useCallback((turnId: string, push = true) => {
    setSelectedTurnId(turnId);
    selectedTurnRef.current = turnId;
    setOpenTerm(null);
    updateUrl(activeSessionRef.current, turnId, push);
    persistSessionState();
  }, [persistSessionState, updateUrl]);

  const loadOlder = useCallback(async () => {
    if (!localMode.current || loadingDirection || !hasOlder || turnsRef.current.length === 0) return;
    const sessionId = activeSessionRef.current;
    const generation = requestSequence.current;
    const currentRange = contiguousWindowRange(turnsRef.current);
    if (!currentRange) return;
    const scroller = scrollRef.current;
    const previousHeight = scroller?.scrollHeight ?? 0;
    const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
    const anchor = scroller
      ? [...scroller.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
          (element) => element.getBoundingClientRect().bottom >= scrollerTop,
        )
      : undefined;
    const anchorId = anchor?.dataset.turnId;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - scrollerTop : null;
    pendingScrollAnchorRef.current = anchorId && anchorOffset !== null
      ? { turnId: anchorId, offset: anchorOffset, previousHeight }
      : null;
    const beforeSequence = currentRange.firstSequence;
    setLoadingDirection("older");
    try {
      const page = await getJson<TurnPage>(
        `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns?beforeSequence=${beforeSequence}&limit=${PAGE_SIZE}&detail=full`,
      );
      if (requestSequence.current !== generation || activeSessionRef.current !== sessionId) {
        pendingScrollAnchorRef.current = null;
        return;
      }
      const incoming = page.turns.filter(isTurn);
      const merged = boundTurnWindow(
        mergeTurns(turnsRef.current, incoming),
        "older",
        selectedTurnRef.current,
      );
      const range = contiguousWindowRange(merged);
      turnsRef.current = merged;
      setTurns(merged);
      setHasOlder((range?.firstSequence ?? 1) > 1);
      setHasNewer((range?.lastSequence ?? 0) < page.latestSequence);
    } catch {
      pendingScrollAnchorRef.current = null;
      if (requestSequence.current === generation && activeSessionRef.current === sessionId) {
        setSyncState("offline");
      }
    } finally {
      if (requestSequence.current === generation && activeSessionRef.current === sessionId) {
        setLoadingDirection(null);
      }
    }
  }, [hasOlder, loadingDirection]);

  const loadNewer = useCallback(async () => {
    if (!localMode.current || loadingDirection || !hasNewer || turnsRef.current.length === 0) return;
    const sessionId = activeSessionRef.current;
    const generation = requestSequence.current;
    const currentRange = contiguousWindowRange(turnsRef.current);
    if (!currentRange) return;
    const afterSequence = currentRange.lastSequence;
    setLoadingDirection("newer");
    try {
      const page = await getJson<TurnPage>(
        `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns?afterSequence=${afterSequence}&limit=${PAGE_SIZE}&detail=full`,
      );
      if (requestSequence.current !== generation || activeSessionRef.current !== sessionId) return;
      const merged = boundTurnWindow(
        mergeTurns(turnsRef.current, page.turns.filter(isTurn)),
        "newer",
        selectedTurnRef.current,
      );
      const range = contiguousWindowRange(merged);
      turnsRef.current = merged;
      setTurns(merged);
      setHasOlder((range?.firstSequence ?? 1) > 1);
      setHasNewer((range?.lastSequence ?? 0) < page.latestSequence);
    } catch {
      if (requestSequence.current === generation && activeSessionRef.current === sessionId) {
        setSyncState("offline");
      }
    } finally {
      if (requestSequence.current === generation && activeSessionRef.current === sessionId) {
        setLoadingDirection(null);
      }
    }
  }, [hasNewer, loadingDirection]);

  const jumpToLatest = useCallback(async (turnId?: string) => {
    const sessionId = activeSessionRef.current;
    const latestTurnId = turnId ?? sessionsRef.current.find((session) => session.id === sessionId)?.latestTurnId ?? null;
    await openSession(sessionId, latestTurnId, false, false, true);
    setPendingLatest(0);
  }, [openSession]);

  useEffect(() => {
    localMode.current = isLocalHost(window.location.hostname);
    const query = new URL(window.location.href).searchParams;
    const requestedSession = query.get("session");
    const requestedTurn = query.get("turn");
    let active = true;

    const start = async () => {
      if (!localMode.current) {
        const available = initialTranscript.sessions.some((session) => session.id === requestedSession);
        await openSession(available && requestedSession ? requestedSession : initialTranscript.sessions[0]?.id ?? "", requestedTurn, false, false);
        return;
      }
      setSyncState("connecting");
      try {
        const next = await refreshSessions();
        if (!active) return;
        const available = next.some((session) => session.id === requestedSession);
        const sessionId = available && requestedSession ? requestedSession : next[0]?.id ?? "";
        const stored = readTabState();
        const initialized: string[] = [];
        for (const session of next) {
          if (session.id === sessionId || stored[session.id]) continue;
          stored[session.id] = {
            scrollTop: 0,
            selectedTurnId: null,
            expandedByTurn: {},
            lastSeenSequence: session.latestSequence,
          };
          initialized.push(session.id);
        }
        if (initialized.length > 0) {
          writeTabState(stored);
          setUnreadBySession((current) => {
            const unread = { ...current };
            initialized.forEach((id) => { unread[id] = 0; });
            return unread;
          });
        }
        setSyncState("live");
        await openSession(sessionId, requestedTurn, false, false);
      } catch {
        if (!active) return;
        setSyncState("offline");
        await openSession(initialTranscript.sessions[0]?.id ?? "", null, false, false);
      }
    };
    void start();

    const popState = () => {
      const params = new URL(window.location.href).searchParams;
      void openSession(params.get("session") ?? sessions[0]?.id ?? "", params.get("turn"), false);
    };
    window.addEventListener("popstate", popState);
    return () => {
      active = false;
      persistSessionState();
      window.removeEventListener("popstate", popState);
    };
    // This is intentionally a one-time bootstrap; live updates have their own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!localMode.current) return;
    let active = true;
    let events: EventSource | null = null;
    const reconcile = async () => {
      try {
        const latestSessions = await refreshSessions();
        if (!active) return;
        const current = latestSessions.find((session) => session.id === activeSessionRef.current);
        const loadedLatest = turnsRef.current.at(-1)?.sequence ?? 0;
        const followedLatest = followedSequenceRef.current;
        if (current && current.latestSequence > loadedLatest && current.latestSequence > followedLatest) {
          const scroller = scrollRef.current;
          const nearBottom = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_DISTANCE;
          if (nearBottom && !hasNewerRef.current) await jumpToLatest();
          else setPendingLatest(current.latestSequence - loadedLatest);
        } else if (current && current.latestSequence <= followedLatest) {
          setPendingLatest(0);
        }
      } catch {
        if (active) setSyncState("offline");
      }
    };

    try {
      events = new EventSource(`${API_BASE}/events`);
      events.onopen = () => {
        if (!active) return;
        setSyncState("live");
        void reconcile();
      };
      events.onerror = () => active && setSyncState("offline");
      events.addEventListener("turn-published", (event) => {
        if (!active) return;
        let notice: { sessionId?: string; turnId?: string; sequence?: number } = {};
        try { notice = JSON.parse((event as MessageEvent<string>).data) as typeof notice; } catch { return; }
        if (!notice.sessionId || !notice.turnId || !Number.isSafeInteger(notice.sequence)) return;
        if (notice.sessionId !== activeSessionRef.current) {
          setUnreadBySession((current) => ({
            ...current,
            [notice.sessionId as string]: (current[notice.sessionId as string] ?? 0) + 1,
          }));
          void refreshSessions();
          return;
        }
        const scroller = scrollRef.current;
        const nearBottom = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_DISTANCE;
        const loadedLatest = turnsRef.current.at(-1)?.sequence ?? 0;
        if (nearBottom && !hasNewerRef.current) {
          if ((notice.sequence as number) > loadedLatest + 1) {
            void jumpToLatest(notice.turnId);
            void refreshSessions();
            return;
          }
          if ((notice.sequence as number) <= loadedLatest) {
            void refreshSessions();
            return;
          }
          const eventGeneration = requestSequence.current;
          void loadTurnById(notice.turnId).then((turn) => {
            if (
              activeSessionRef.current !== notice.sessionId ||
              requestSequence.current !== eventGeneration
            ) return;
            if (!turn || turn.sessionId !== notice.sessionId) {
              setPendingLatest((current) => Math.max(current, (notice.sequence as number) - loadedLatest, 1));
              return;
            }
            const latestNow = turnsRef.current.at(-1)?.sequence ?? 0;
            if (turn.sequence <= latestNow) {
              void refreshSessions();
              return;
            }
            const currentScroller = scrollRef.current;
            const stillFollowing = !!currentScroller &&
              currentScroller.scrollHeight - currentScroller.scrollTop - currentScroller.clientHeight <= FOLLOW_DISTANCE &&
              !hasNewerRef.current;
            const merged = boundTurnWindow(
              mergeTurns(turnsRef.current, [turn]),
              "newer",
              stillFollowing ? turn.id : selectedTurnRef.current,
            );
            const range = contiguousWindowRange(merged);
            turnsRef.current = merged;
            setTurns(merged);
            setHasOlder((range?.firstSequence ?? 1) > 1);
            setHasNewer(false);
            if (!stillFollowing) {
              setPendingLatest((current) => Math.max(current, turn.sequence - latestNow, 1));
              setUnreadBySession((current) => ({
                ...current,
                [turn.sessionId]: (current[turn.sessionId] ?? 0) + 1,
              }));
              return;
            }
            followedSequenceRef.current = Math.max(followedSequenceRef.current, turn.sequence);
            selectTurn(turn.id, false);
            markSeen(turn.sessionId, turn.sequence);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              setPendingLatest(0);
            }));
          });
        } else {
          setPendingLatest((current) => current + 1);
          setUnreadBySession((current) => ({
            ...current,
            [notice.sessionId as string]: (current[notice.sessionId as string] ?? 0) + 1,
          }));
        }
        void refreshSessions();
      });
    } catch {
      // The bootstrap state already communicates whether local sync is available.
    }
    return () => {
      active = false;
      events?.close();
    };
  }, [jumpToLatest, loadTurnById, markSeen, refreshSessions, selectTurn]);

  useEffect(() => {
    if (!openTerm) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (openTerm.trigger.contains(event.target) || event.target.closest("[data-term-popover]")) return;
      setOpenTerm(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = openTerm.trigger;
      setOpenTerm(null);
      requestAnimationFrame(() => trigger.focus());
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [openTerm]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (persistFrame.current !== null) cancelAnimationFrame(persistFrame.current);
  }, []);

  const toggle = useCallback((turnId: string, key: string) => {
    const paths = new Set(expandedByTurnRef.current[turnId] ?? []);
    if (paths.has(key)) paths.delete(key);
    else paths.add(key);
    const next = { ...expandedByTurnRef.current, [turnId]: paths };
    expandedByTurnRef.current = next;
    setExpandedByTurn(next);
    queueMicrotask(persistSessionState);
  }, [persistSessionState]);

  const setAllExpanded = useCallback((turn: TranscriptTurn, open: boolean) => {
    const next = {
      ...expandedByTurnRef.current,
      [turn.id]: open ? expandablePaths(turn.answer.root) : new Set<string>(),
    };
    expandedByTurnRef.current = next;
    setExpandedByTurn(next);
    queueMicrotask(persistSessionState);
  }, [persistSessionState]);

  const copy = useCallback(async (complete: boolean) => {
    const turn = turnsRef.current.find((candidate) => candidate.id === selectedTurnRef.current);
    if (!turn) return;
    try {
      await copyToClipboard(copyText(turn.answer, expandedByTurn[turn.id] ?? new Set(), complete));
      setCopyState(complete ? "complete" : "visible");
    } catch {
      setCopyState("error");
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState(null), 2200);
  }, [expandedByTurn]);

  const cancelAnchorCorrection = useCallback(() => {
    userScrollIntentRef.current += 1;
    anchorCorrectionActiveRef.current = false;
    const scroller = scrollRef.current;
    if (scroller && anchorCorrectionScrollBehaviorRef.current !== null) {
      scroller.style.scrollBehavior = anchorCorrectionScrollBehaviorRef.current;
      anchorCorrectionScrollBehaviorRef.current = null;
    }
  }, []);

  const onScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const range = scroller.scrollHeight - scroller.clientHeight;
    const progress = range > 0 ? scroller.scrollTop / range : 0;
    if (progressRef.current) progressRef.current.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
    if (!anchorCorrectionActiveRef.current && persistFrame.current === null) {
      persistFrame.current = requestAnimationFrame(() => {
        persistFrame.current = null;
        persistSessionState();
      });
    }
    if (anchorCorrectionActiveRef.current) return;
    if (range - scroller.scrollTop <= FOLLOW_DISTANCE && activeSession && !hasNewer && pendingLatest === 0) {
      markSeen(activeSession.id, activeSession.latestSequence);
    }
  }, [activeSession, hasNewer, markSeen, pendingLatest, persistSessionState]);

  const syncLabel = syncState === "live"
    ? "Live local transcript"
    : syncState === "connecting"
      ? "Checking local transcript"
      : syncState === "offline"
        ? "Demo edition · local service unavailable"
        : "Hosted demo edition";
  const popoverTerms = openTerm
    ? turns.find((turn) => turn.id === openTerm.turnId)?.answer.terms ?? {}
    : {};

  return (
    <main className="viewer-shell">
      <div className="reading-progress" aria-hidden="true"><span ref={progressRef} /></div>

      <header className="app-header">
        <button type="button" className="sidebar-toggle" aria-expanded={sidebarOpen} aria-controls="session-sidebar" onClick={() => setSidebarOpen((open) => !open)}>
          Sessions
        </button>
        <div className="brand-lockup">
          <span className="edition-mark" aria-hidden="true"><span /></span>
          <span><strong>Semantic Answer Tree</strong><small>Explore every answer, branch by branch</small></span>
        </div>
        <div className="active-heading">
          <span>
            {activeSession?.title ?? "No session"}
            {activeSession?.temporary ? (
              <span className="active-temporary-badge" data-testid="active-temporary-badge" title="Isolated identity; retained in local history">
                Temporary
              </span>
            ) : null}
          </span>
          <h1 data-testid="viewer-title">{selectedTurn?.answer.title ?? "Semantic transcript"}</h1>
        </div>
        <span className={`sync-state sync-${syncState}`}><span aria-hidden="true" /> {syncLabel}</span>
      </header>

      <div className="transcript-layout">
        <aside id="session-sidebar" className={`session-sidebar${sidebarOpen ? " sidebar-open" : ""}`} aria-label="Answer sessions">
          <div className="sidebar-heading">
            <span>Sessions</span>
            <span>{sessions.length}</span>
          </div>
          <nav data-testid="session-list">
            {sessions.map((session) => {
              const active = session.id === activeSessionId;
              const unread = unreadBySession[session.id] ?? 0;
              return (
                <button
                  type="button"
                  key={session.id}
                  className={`session-item${active ? " session-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  data-testid={`session-${sanitize(session.id)}`}
                  onClick={() => void openSession(session.id, null, true)}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    {session.turnCount} {session.turnCount === 1 ? "turn" : "turns"}
                    {session.temporary ? (
                      <span
                        className="temporary-session-badge"
                        data-testid={`temporary-badge-${sanitize(session.id)}`}
                        title="Isolated identity; retained in local history"
                      >
                        Temporary
                      </span>
                    ) : null}
                    {unread > 0 ? <strong data-testid={`unread-badge-${sanitize(session.id)}`} aria-label={`${unread} unread turns`}>{unread}</strong> : null}
                  </span>
                </button>
              );
            })}
          </nav>
          <p className="sidebar-note">Read-only history. New answers are published from Codex.</p>
        </aside>

        <section className="transcript-panel" aria-label="Session transcript">
          {pendingLatest > 0 ? (
            <button type="button" className="new-turn-banner" data-testid="new-turn-banner" onClick={() => void jumpToLatest()}>
              {pendingLatest} new {pendingLatest === 1 ? "turn" : "turns"} · Jump to latest
            </button>
          ) : null}
          <div
            className="transcript-scroll"
            ref={scrollRef}
            onScroll={onScroll}
            onWheelCapture={cancelAnchorCorrection}
            onTouchStartCapture={cancelAnchorCorrection}
            onPointerDownCapture={cancelAnchorCorrection}
            onKeyDownCapture={cancelAnchorCorrection}
            data-testid="transcript-scroller"
          >
            <div className="transcript-column">
              <div className="history-boundary" aria-live="polite">
                {hasOlder ? (
                  <button type="button" data-testid="load-older" onClick={() => void loadOlder()} disabled={loadingDirection !== null}>
                    {loadingDirection === "older" ? "Loading earlier turns…" : "Load earlier turns"}
                  </button>
                ) : <span>Beginning of session</span>}
              </div>

              {turns.map((turn) => (
                <TurnCard
                  key={turn.id}
                  turn={turn}
                  latest={turn.sequence === activeSession?.latestSequence}
                  selected={turn.id === selectedTurnId}
                  expanded={expandedByTurn[turn.id] ?? new Set()}
                  copyState={turn.id === selectedTurnId ? copyState : null}
                  openTerm={openTerm}
                  onSelect={() => selectTurn(turn.id)}
                  onToggle={(key) => toggle(turn.id, key)}
                  onExpandAll={() => setAllExpanded(turn, true)}
                  onCollapseAll={() => setAllExpanded(turn, false)}
                  onCopy={(complete) => void copy(complete)}
                  setOpenTerm={setOpenTerm}
                />
              ))}

              {turns.length === 0 && loadingDirection === null ? (
                <div className="empty-transcript"><h2>No turns yet</h2><p>This session is ready for its first published answer.</p></div>
              ) : null}

              <div className="history-boundary history-newer">
                {hasNewer ? (
                  <button type="button" data-testid="load-newer" onClick={() => void loadNewer()} disabled={loadingDirection !== null}>
                    {loadingDirection === "newer" ? "Loading newer turns…" : "Load newer turns"}
                  </button>
                ) : turns.length ? <span>Latest committed turn</span> : null}
              </div>
            </div>
          </div>
        </section>
      </div>

      {openTerm ? (
        <TermPopover
          openTerm={openTerm}
          terms={popoverTerms}
          onClose={() => {
            const trigger = openTerm.trigger;
            setOpenTerm(null);
            requestAnimationFrame(() => trigger.focus());
          }}
        />
      ) : null}
    </main>
  );
}
