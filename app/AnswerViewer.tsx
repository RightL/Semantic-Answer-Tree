"use client";

import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  expansionIdFromZoomHref,
  extractZoomReferences,
} from "@/shared/zoom-links.mjs";

export type SemanticExpansion = {
  kind: "definition" | "detail";
  title?: string;
  content: string;
};

export type SemanticAnswer = {
  version: 1;
  title: string;
  body: string;
  expansions?: Record<string, SemanticExpansion>;
};

export type TranscriptSession = {
  id: string;
  title: string;
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
  lastSeenSequence: number;
  anchorTurnId?: string | null;
  anchorSequence?: number | null;
  anchorOffset?: number;
};

type StoredTabState = Record<string, StoredSessionState>;
type SyncState = "file" | "connecting" | "live" | "offline";
type CopyState = "visible" | "complete" | "error" | null;
type OpenExpansion = {
  instanceId: string;
  turnId: string;
  expansionId: string;
  expansion: SemanticExpansion;
  trigger: HTMLButtonElement;
  triggerId: string;
  anchorLeft?: number;
  anchorTop?: number;
  anchorBottom?: number;
} | null;

const DEFAULT_API_BASE = "http://127.0.0.1:4318";
const API_BASE =
  process.env.NEXT_PUBLIC_SEMANTIC_ANSWER_API?.replace(/\/+$/, "") ||
  DEFAULT_API_BASE;
const TAB_STATE_KEY = "semantic-transcript-reader-v2";
const PAGE_SIZE = 20;
const MAX_RENDERED_TURNS = 80;
const CONTIGUOUS_WINDOW_LIMIT = MAX_RENDERED_TURNS - 1;
const FOLLOW_DISTANCE = 140;
const SEMANTIC_SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "zoom"],
  },
};
const TOP_LEVEL_FIELDS = new Set(["version", "title", "body", "expansions"]);
const EXPANSION_FIELDS = new Set(["kind", "title", "content"]);
const EXPANSION_ID_PATTERN = /^[a-z0-9._-]+$/;
const MAX_EXPANSIONS = 500;

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function withoutZoomLinks(markdown: string): string {
  const references = extractZoomReferences(markdown);
  let result = markdown;
  for (const reference of references.reverse()) {
    result = `${result.slice(0, reference.index)}${reference.label}${result.slice(reference.index + reference.length)}`;
  }
  return result;
}

function isAnswer(value: unknown): value is SemanticAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(answer, TOP_LEVEL_FIELDS) ||
    answer.version !== 1 ||
    typeof answer.title !== "string" ||
    answer.title.trim().length === 0 ||
    new TextEncoder().encode(answer.title).byteLength > 4 * 1_024 ||
    typeof answer.body !== "string" ||
    answer.body.trim().length === 0 ||
    new TextEncoder().encode(answer.body).byteLength > 1_024 * 1_024
  ) {
    return false;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1_024 * 1_024) {
    return false;
  }
  if (
    answer.expansions !== undefined &&
    (!answer.expansions || typeof answer.expansions !== "object" || Array.isArray(answer.expansions))
  ) {
    return false;
  }
  const expansions = (answer.expansions ?? {}) as Record<string, unknown>;
  const entries = Object.entries(expansions);
  if (
    entries.length > MAX_EXPANSIONS ||
    entries.some(
      ([expansionId, candidate]) => {
        if (
          !EXPANSION_ID_PATTERN.test(expansionId) ||
          expansionId.length > 128 ||
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) return true;
        const expansion = candidate as Record<string, unknown>;
        return (
          !hasOnlyKeys(expansion, EXPANSION_FIELDS) ||
          (expansion.kind !== "definition" && expansion.kind !== "detail") ||
          (expansion.title !== undefined && (
            typeof expansion.title !== "string" ||
            new TextEncoder().encode(expansion.title).byteLength > 4 * 1_024
          )) ||
          typeof expansion.content !== "string" ||
          expansion.content.trim().length === 0 ||
          new TextEncoder().encode(expansion.content).byteLength > 256 * 1_024 ||
          extractZoomReferences(expansion.content as string).length > 0
        );
      },
    )
  ) {
    return false;
  }
  const references = extractZoomReferences(answer.body);
  const referenced = new Set(references.map(({ id }) => id));
  return (
    references.every(({ hasRenderedText }) => hasRenderedText) &&
    references.every(({ id }) => EXPANSION_ID_PATTERN.test(id) && owns(expansions, id)) &&
    entries.every(([id]) => referenced.has(id))
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

function copyText(answer: SemanticAnswer, complete: boolean): string {
  const passages = [`# ${answer.title.trim()}`, withoutZoomLinks(answer.body).trim()];
  if (!complete) return passages.join("\n\n");

  const seen = new Set<string>();
  const appendix: string[] = [];
  for (const reference of extractZoomReferences(answer.body)) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    const expansion = answer.expansions?.[reference.id];
    if (!expansion) continue;
    const fallbackTitle = withoutZoomLinks(reference.label).replace(/[*_`]/g, "").trim();
    appendix.push(`### ${expansion.title?.trim() || fallbackTitle || "More context"}`, expansion.content.trim());
  }
  if (appendix.length) passages.push("## Expansions", ...appendix);
  return passages.join("\n\n");
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
  return url.startsWith("zoom:") ? url : defaultUrlTransform(url);
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

function reactText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => typeof child === "string" || typeof child === "number" ? String(child) : "")
    .join("");
}

function ZoomLink({
  href,
  instanceId,
  turnId,
  expansion,
  children,
  openExpansion,
  setOpenExpansion,
}: {
  href: string;
  instanceId: string;
  turnId: string;
  expansion: SemanticExpansion;
  children: ReactNode;
  openExpansion: OpenExpansion;
  setOpenExpansion: (value: OpenExpansion) => void;
}) {
  const expansionId = expansionIdFromZoomHref(href);
  const stableTurn = sanitize(turnId);
  const stableExpansion = sanitize(expansionId);
  const triggerId = `zoom-trigger-${stableTurn}-${stableExpansion}-${sanitize(instanceId)}`;
  const open = openExpansion?.instanceId === instanceId && openExpansion.turnId === turnId;
  const surfaceId = expansion.kind === "definition"
    ? `definition-popover-${stableTurn}`
    : `detail-panel-${stableTurn}`;
  const label = reactText(children).trim();
  const quietDetail = expansion.kind === "detail" && label.toLowerCase() === "details";
  const accessibleLabel = expansion.kind === "definition"
    ? `Open definition: ${expansion.title?.trim() || label || expansionId}`
    : `Open details: ${expansion.title?.trim() || label || "More context"}`;

  return (
    <span className="zoom-anchor">
      <button
        id={triggerId}
        type="button"
        className={`zoom-trigger zoom-${expansion.kind}-trigger${quietDetail ? " zoom-detail-ellipsis" : ""}`}
        data-zoom-trigger
        data-expansion-id={expansionId}
        data-testid={`zoom-anchor-${stableTurn}-${stableExpansion}`}
        aria-label={quietDetail ? accessibleLabel : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={surfaceId}
        title={quietDetail ? "Details" : undefined}
        onClick={(event) => {
          if (open) {
            setOpenExpansion(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const popoverWidth = Math.min(360, window.innerWidth - 32);
          const anchorLeft = Math.min(
            window.innerWidth - popoverWidth / 2 - 16,
            Math.max(popoverWidth / 2 + 16, rect.left + rect.width / 2),
          );
          const placeBelow = rect.top < 230;
          setOpenExpansion({
            instanceId,
            turnId,
            expansionId,
            expansion,
            trigger: event.currentTarget,
            triggerId,
            anchorLeft,
            anchorTop: placeBelow ? rect.bottom + 12 : undefined,
            anchorBottom: placeBelow ? undefined : window.innerHeight - rect.top + 12,
          });
        }}
      >
        {quietDetail ? <span aria-hidden="true">…</span> : children}
      </button>
    </span>
  );
}

function Markdown({
  content,
  turnId,
  expansions,
  openExpansion,
  setOpenExpansion,
  allowZoom = true,
  scope = "body",
}: {
  content: string;
  turnId: string;
  expansions?: Record<string, SemanticExpansion>;
  openExpansion: OpenExpansion;
  setOpenExpansion: (value: OpenExpansion) => void;
  allowZoom?: boolean;
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
            if (href.startsWith("zoom:")) {
              const expansionId = expansionIdFromZoomHref(href);
              const expansion = expansions?.[expansionId];
              if (!allowZoom || !expansion) return <>{children}</>;
              return (
                <ZoomLink
                  href={href}
                  instanceId={`${scope}-${node?.position?.start.offset ?? href}`}
                  turnId={turnId}
                  expansion={expansion}
                  openExpansion={openExpansion}
                  setOpenExpansion={setOpenExpansion}
                >
                  {children}
                </ZoomLink>
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

function ExpansionSurface({
  openExpansion,
  onClose,
}: {
  openExpansion: NonNullable<OpenExpansion>;
  onClose: () => void;
}) {
  const stableTurn = sanitize(openExpansion.turnId);
  const title = openExpansion.expansion.title?.trim() ||
    (openExpansion.expansion.kind === "definition" ? "Definition" : "Details");
  const content = (
    <Markdown
      content={openExpansion.expansion.content}
      turnId={openExpansion.turnId}
      openExpansion={null}
      setOpenExpansion={() => undefined}
      allowZoom={false}
      scope={`${openExpansion.expansion.kind}-content`}
    />
  );

  if (openExpansion.expansion.kind === "definition") {
    return (
      <aside
        id={`definition-popover-${stableTurn}`}
        className="definition-popover"
        data-expansion-surface
        data-testid={`definition-popover-${stableTurn}`}
        role="dialog"
        aria-labelledby={`definition-title-${stableTurn}`}
        style={{
          left: openExpansion.anchorLeft,
          top: openExpansion.anchorTop,
          bottom: openExpansion.anchorBottom,
        }}
      >
        <span className="expansion-kicker">Definition</span>
        <h3 id={`definition-title-${stableTurn}`}>{title}</h3>
        <div className="definition-content">{content}</div>
        <button type="button" className="expansion-close" data-expansion-close aria-label="Close definition" onClick={onClose}>
          Close
        </button>
      </aside>
    );
  }

  return (
    <div className="detail-overlay" data-expansion-overlay>
      <aside
        id={`detail-panel-${stableTurn}`}
        className="detail-panel"
        data-expansion-surface
        data-testid={`detail-panel-${stableTurn}`}
        role="dialog"
        aria-labelledby={`detail-title-${stableTurn}`}
      >
        <header className="detail-heading">
          <div>
            <span className="expansion-kicker">Supporting detail</span>
            <h3 id={`detail-title-${stableTurn}`}>{title}</h3>
          </div>
          <button
            type="button"
            className="detail-close"
            data-detail-close
            aria-label="Close details"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="detail-content">{content}</div>
      </aside>
    </div>
  );
}

function TurnCard({
  turn,
  latest,
  selected,
  copyState,
  openExpansion,
  onSelect,
  onCopy,
  setOpenExpansion,
}: {
  turn: TranscriptTurn;
  latest: boolean;
  selected: boolean;
  copyState: CopyState;
  openExpansion: OpenExpansion;
  onSelect: () => void;
  onCopy: (complete: boolean) => void;
  setOpenExpansion: (value: OpenExpansion) => void;
}) {
  const stableTurn = sanitize(turn.id);
  const copyMessage =
    copyState === "visible"
      ? "Answer body copied"
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
            <span className="toolbar-kicker">Answer actions</span>
            <span>Copy this turn for use elsewhere</span>
          </div>
          <div className="toolbar-actions">
            <button type="button" data-testid="copy-body" onClick={() => onCopy(false)}>
              Copy body
            </button>
            <button type="button" data-testid="copy-complete" onClick={() => onCopy(true)}>
              Copy complete
            </button>
          </div>
          <span className="copy-status" role="status" aria-live="polite">{copyMessage}</span>
        </div>
      ) : null}

      <div className="answer-body" data-testid={`turn-answer-${stableTurn}`} data-answer-body={turn.id}>
        <Markdown
          content={turn.answer.body}
          turnId={turn.id}
          expansions={turn.answer.expansions}
          openExpansion={openExpansion}
          setOpenExpansion={setOpenExpansion}
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
  const [unreadBySession, setUnreadBySession] = useState<Record<string, number>>({});
  const [hasOlder, setHasOlder] = useState(initialSession ? initialSession.turnCount > initialTurns.length : false);
  const [hasNewer, setHasNewer] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("file");
  const [copyState, setCopyState] = useState<CopyState>(null);
  const [loadingDirection, setLoadingDirection] = useState<"older" | "newer" | "latest" | null>(null);
  const [pendingLatest, setPendingLatest] = useState(0);
  const [openExpansion, setOpenExpansion] = useState<OpenExpansion>(null);
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
    const anchor = visibleTurnAnchor(scrollRef.current);
    stored[sessionId] = {
      scrollTop: scrollRef.current?.scrollTop ?? current?.scrollTop ?? 0,
      selectedTurnId: selectedTurnRef.current,
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
      const payload = await getJson<{ turn: unknown }>(`${API_BASE}/api/turns/${encodeURIComponent(turnId)}`);
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
      hasNewerRef.current = false;
      setActiveSessionId("");
      setTurns([]);
      setSelectedTurnId(null);
      setUnreadBySession({});
      setHasOlder(false);
      setHasNewer(false);
      setLoadingDirection(null);
      setPendingLatest(0);
      setOpenExpansion(null);
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
    setOpenExpansion(null);
    setCopyState(null);
    setPendingLatest(0);
    setLoadingDirection("latest");
    const stored = readTabState()[sessionId];

    try {
      const fetchPage = async (beforeSequence?: number): Promise<TurnPage> => {
        if (localMode.current) {
          const cursor = beforeSequence === undefined ? "" : `&beforeSequence=${beforeSequence}`;
          return getJson<TurnPage>(
            `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns?limit=${PAGE_SIZE}${cursor}`,
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
  }, [initialTranscript.turns, loadTurnById, persistSessionState, restoreScroll, updateUrl]);

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
    setOpenExpansion(null);
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
        `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns?beforeSequence=${beforeSequence}&limit=${PAGE_SIZE}`,
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
        `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/turns?afterSequence=${afterSequence}&limit=${PAGE_SIZE}`,
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

  const closeExpansion = useCallback((restoreFocus = true) => {
    const trigger = openExpansion?.trigger;
    const triggerId = openExpansion?.triggerId;
    setOpenExpansion(null);
    if (restoreFocus && triggerId) {
      requestAnimationFrame(() => {
        setTimeout(() => {
          const currentTrigger = document.getElementById(triggerId) as HTMLButtonElement | null;
          if (currentTrigger) currentTrigger.focus({ preventScroll: true });
          else if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        }, 0);
      });
    }
  }, [openExpansion]);

  useEffect(() => {
    if (!openExpansion) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (
        openExpansion.trigger.contains(event.target) ||
        event.target.closest("[data-zoom-trigger]") ||
        event.target.closest("[data-expansion-surface]")
      ) return;
      closeExpansion();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeExpansion();
        return;
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    requestAnimationFrame(() => {
      const selector = openExpansion.expansion.kind === "detail"
        ? "[data-detail-close]"
        : "[data-expansion-close]";
      document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
    };
  }, [closeExpansion, openExpansion]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (persistFrame.current !== null) cancelAnimationFrame(persistFrame.current);
  }, []);

  const copy = useCallback(async (complete: boolean) => {
    const turn = turnsRef.current.find((candidate) => candidate.id === selectedTurnRef.current);
    if (!turn) return;
    try {
      await copyToClipboard(copyText(turn.answer, complete));
      setCopyState(complete ? "complete" : "visible");
    } catch {
      setCopyState("error");
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState(null), 2200);
  }, []);

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
  return (
    <main className="viewer-shell">
      <div className="reading-progress" aria-hidden="true"><span ref={progressRef} /></div>

      <header className="app-header">
        <button type="button" className="sidebar-toggle" aria-expanded={sidebarOpen} aria-controls="session-sidebar" onClick={() => setSidebarOpen((open) => !open)}>
          Sessions
        </button>
        <div className="brand-lockup">
          <span className="edition-mark" aria-hidden="true"><span /></span>
          <span><strong>Semantic Answer</strong><small>Read the answer. Open only the detail you need.</small></span>
        </div>
        <div className="active-heading">
          <span>{activeSession?.title ?? "No session"}</span>
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
                  copyState={turn.id === selectedTurnId ? copyState : null}
                  openExpansion={openExpansion}
                  onSelect={() => selectTurn(turn.id)}
                  onCopy={(complete) => void copy(complete)}
                  setOpenExpansion={setOpenExpansion}
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

      {openExpansion ? (
        <ExpansionSurface openExpansion={openExpansion} onClose={() => closeExpansion()} />
      ) : null}
    </main>
  );
}
