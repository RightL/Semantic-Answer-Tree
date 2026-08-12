import { expect, type APIRequestContext, type Page } from "@playwright/test";

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

export type PublishResult = {
  ok: true;
  sessionId: string;
  turnId: string;
  sequence: number;
};

export type PublishedTurn = PublishResult & {
  requestSummary: string;
  document: SemanticAnswer;
};

export const apiBaseUrl = () => {
  const value = process.env.SEMANTIC_ANSWER_API_BASE;
  if (!value) throw new Error("Browser-test API URL is unavailable.");
  return value;
};

export const viewerBaseUrl = () => {
  const value = process.env.SEMANTIC_TRANSCRIPT_TEST_VIEWER_URL;
  if (!value) throw new Error("Browser-test viewer URL is unavailable.");
  return value;
};

export const capabilityToken = () => {
  const value = process.env.SEMANTIC_ANSWER_TOKEN;
  if (!value) throw new Error("Browser-test capability token is unavailable.");
  return value;
};

let uniqueCounter = 0;

export function uniqueKey(label: string) {
  uniqueCounter += 1;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `pw-${process.env.SEMANTIC_TRANSCRIPT_TEST_RUN_ID}-${slug}-${uniqueCounter}`;
}

export function semanticAnswer(
  label: string,
  options: {
    deepCanary?: string;
    remoteImageUrl?: string;
    termDefinition?: string;
  } = {},
): SemanticAnswer {
  const imageMarkdown = options.remoteImageUrl
    ? `\n\n![remote beacon](${options.remoteImageUrl})`
    : "";
  return {
    version: 1,
    title: `${label} answer`,
    root: {
      content:
        `${label} root with [Semantic Answer Tree](term:semantic-answer-tree).` +
        imageMarkdown,
      children: [
        {
          content: `${label} branch alpha`,
          children: [
            {
              content: `${label} alpha detail`,
              children: [
                {
                  content:
                    options.deepCanary ?? `${label} deeply hidden explanation`,
                },
              ],
            },
            { content: `${label} alpha sibling` },
          ],
        },
        {
          content: `${label} branch beta`,
          children: [{ content: `${label} beta detail` }],
        },
      ],
    },
    terms: {
      "semantic-answer-tree":
        options.termDefinition ?? `${label} turn-scoped Semantic Answer Tree definition.`,
    },
  };
}

export async function publishTurn(
  request: APIRequestContext,
  options: {
    document?: SemanticAnswer;
    idempotencyKey?: string;
    requestSummary?: string;
    sourceSessionKey: string;
    sourceTurnKey?: string;
  },
): Promise<PublishedTurn> {
  const turnKey = options.sourceTurnKey ?? uniqueKey("turn");
  const document = options.document ?? semanticAnswer(turnKey);
  const requestSummary = options.requestSummary ?? `Request for ${turnKey}`;
  const response = await request.post(`${apiBaseUrl()}/api/publish`, {
    data: {
      sourceSessionKey: options.sourceSessionKey,
      sourceTurnKey: turnKey,
      requestSummary,
      document,
      idempotencyKey: options.idempotencyKey ?? `idem-${turnKey}`,
    },
    headers: {
      Authorization: `Bearer ${capabilityToken()}`,
    },
  });
  const responseText = await response.text();
  expect(response.ok(), responseText).toBe(true);
  const result = JSON.parse(responseText) as PublishResult;
  expect(result).toMatchObject({
    ok: true,
    sessionId: expect.any(String),
    turnId: expect.any(String),
    sequence: expect.any(Number),
  });
  return { ...result, document, requestSummary };
}

export async function publishMany(
  request: APIRequestContext,
  sourceSessionKey: string,
  count: number,
  options: {
    concurrency?: number;
    deepCanary?: string;
    label?: string;
  } = {},
): Promise<PublishedTurn[]> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const jobs = Array.from({ length: count }, (_, index) => {
    const label = `${options.label ?? "history"} ${String(index + 1).padStart(3, "0")}`;
    return () =>
      publishTurn(request, {
        document: semanticAnswer(label, { deepCanary: options.deepCanary }),
        requestSummary: `Summarize ${label}`,
        sourceSessionKey,
        sourceTurnKey: `${sourceSessionKey}-turn-${index + 1}`,
      });
  });

  const results: PublishedTurn[] = [];
  for (let offset = 0; offset < jobs.length; offset += concurrency) {
    const batch = jobs.slice(offset, offset + concurrency);
    results.push(...(await Promise.all(batch.map((job) => job()))));
  }
  return results.sort((left, right) => left.sequence - right.sequence);
}

export function sessionItem(page: Page, sessionId: string) {
  return page.getByTestId(`session-${sessionId}`);
}

export function turnCard(page: Page, turnId: string) {
  return page.getByTestId(`turn-${turnId}`);
}

export function renderedTurnCards(page: Page) {
  return page.locator('[data-testid^="turn-"][data-sequence]');
}

export async function gotoSession(
  page: Page,
  sessionId: string,
  turnId?: string,
) {
  const url = new URL(viewerBaseUrl());
  url.searchParams.set("session", sessionId);
  if (turnId) url.searchParams.set("turn", turnId);
  const eventStreamConnected = page.waitForResponse((response) => {
    const responseUrl = new URL(response.url());
    return responseUrl.pathname === "/events" && response.status() === 200;
  });
  await page.goto(url.href);
  await eventStreamConnected;
  // On narrow screens the closed drawer intentionally keeps session buttons
  // attached but hidden and outside the tab order.
  await expect(sessionItem(page, sessionId)).toBeAttached();
  if (turnId) await expect(turnCard(page, turnId)).toBeVisible();
}

export async function scrollTranscriptTo(page: Page, position: "bottom" | "top") {
  const scroller = page.getByTestId("transcript-scroller");
  const setPosition = () =>
    scroller.evaluate((element, target) => {
      const previousBehavior = element.style.scrollBehavior;
      element.style.scrollBehavior = "auto";
      element.scrollTop = target === "bottom" ? element.scrollHeight : 0;
      void element.scrollTop;
      element.style.scrollBehavior = previousBehavior;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, position);
  await setPosition();
  if (position === "bottom") {
    // `content-visibility:auto` can increase scrollHeight after offscreen cards
    // materialize. Follow that bounded layout settling just as an End action
    // would, then assert the reader is genuinely at the live edge.
    for (let frame = 0; frame < 6; frame += 1) {
      await page.waitForTimeout(50);
      await setPosition();
    }
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThan(48);
  }
}

export async function scrollMetrics(page: Page) {
  return page.getByTestId("transcript-scroller").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
}

export async function setTranscriptReadingPosition(page: Page, ratio: number) {
  const scroller = page.getByTestId("transcript-scroller");
  await expect
    .poll(() =>
      scroller.evaluate((element) => element.scrollHeight - element.clientHeight),
    )
    .toBeGreaterThan(500);
  await scroller.evaluate((element, requestedRatio) => {
    const range = element.scrollHeight - element.clientHeight;
    const previousBehavior = element.style.scrollBehavior;
    element.style.scrollBehavior = "auto";
    element.scrollTop = Math.max(180, Math.min(range - 220, range * requestedRatio));
    void element.scrollTop;
    element.style.scrollBehavior = previousBehavior;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, ratio);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.waitForTimeout(100);
  return scrollMetrics(page);
}

export type VisibleTurnAnchor = {
  testId: string;
  top: number;
};

export async function visibleTurnAnchor(page: Page): Promise<VisibleTurnAnchor> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="transcript-scroller"]',
    );
    if (!scroller) throw new Error("Missing transcript scroller");
    const scrollerRect = scroller.getBoundingClientRect();
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="turn-"][data-sequence]'),
    );
    const card = cards.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 1 && rect.top < scrollerRect.bottom - 1;
    });
    if (!card?.dataset.testid) throw new Error("No visible turn anchor");
    return {
      testId: card.dataset.testid,
      top: card.getBoundingClientRect().top - scrollerRect.top,
    };
  });
}

export async function anchorOffset(page: Page, anchor: VisibleTurnAnchor) {
  return page.getByTestId(anchor.testId).evaluate((element) => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="transcript-scroller"]',
    );
    if (!scroller) throw new Error("Missing transcript scroller");
    return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
}

export async function storedSessionAnchorId(page: Page, sessionId: string) {
  return page.evaluate((requestedSessionId) => {
    const raw = sessionStorage.getItem("semantic-transcript-reader-v1");
    if (!raw) return null;
    try {
      const state = JSON.parse(raw) as Record<
        string,
        { anchorTurnId?: unknown }
      >;
      const value = state[requestedSessionId]?.anchorTurnId;
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }, sessionId);
}

export async function clickTurn(page: Page, turnId: string) {
  const card = turnCard(page, turnId);
  await card.scrollIntoViewIfNeeded();
  if ((await card.getAttribute("data-selected")) !== "true") {
    await card.getByRole("button", { name: "Read this turn" }).click();
  }
  await expect(card).toHaveAttribute("data-selected", "true");
  await expect(page).toHaveURL(new RegExp(`[?&]turn=${encodeURIComponent(turnId)}(?:&|$)`));
}
