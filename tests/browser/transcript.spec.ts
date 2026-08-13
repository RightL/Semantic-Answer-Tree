import { expect, test } from "@playwright/test";

import {
  anchorOffset,
  apiBaseUrl,
  clickTurn,
  gotoSession,
  publishMany,
  publishTurn,
  renderedTurnCards,
  scrollMetrics,
  scrollTranscriptTo,
  semanticAnswer,
  setTranscriptReadingPosition,
  storedSessionAnchorId,
  sessionItem,
  turnCard,
  uniqueKey,
  visibleTurnAnchor,
  viewerBaseUrl,
  zoomAnchor,
} from "./fixtures";

test("temporary Codex sessions are visibly labeled without labeling durable sessions", async ({
  page,
  request,
}) => {
  const temporary = await publishTurn(request, {
    sourceSessionKey: `codex-temporary:v1:${uniqueKey("temporary session")}`,
    sourceTurnKey: uniqueKey("temporary turn"),
  });
  const durable = await publishTurn(request, {
    sourceSessionKey: uniqueKey("durable session"),
    sourceTurnKey: uniqueKey("durable turn"),
  });

  await gotoSession(page, temporary.sessionId, temporary.turnId);
  await expect(page.getByTestId(`temporary-badge-${temporary.sessionId}`)).toHaveText(
    "Temporary",
  );
  await expect(page.getByTestId("active-temporary-badge")).toHaveText("Temporary");
  await expect(page.getByTestId(`temporary-badge-${durable.sessionId}`)).toHaveCount(0);
});

test("a background-session publication never steals focus and increments unread", async ({
  page,
  request,
}) => {
  const active = await publishTurn(request, {
    sourceSessionKey: uniqueKey("active session"),
    sourceTurnKey: uniqueKey("active first"),
  });
  const backgroundKey = uniqueKey("background session");
  const background = await publishTurn(request, {
    sourceSessionKey: backgroundKey,
    sourceTurnKey: uniqueKey("background first"),
  });

  await gotoSession(page, active.sessionId, active.turnId);
  await expect(turnCard(page, active.turnId)).toHaveAttribute("data-selected", "true");
  const unread = page.getByTestId(`unread-badge-${background.sessionId}`);
  const unreadBefore = (await unread.count()) ? Number(await unread.textContent()) : 0;

  const backgroundUpdate = await publishTurn(request, {
    sourceSessionKey: backgroundKey,
    sourceTurnKey: uniqueKey("background update"),
  });

  await expect(unread).toHaveText(String(unreadBefore + 1));
  await expect(turnCard(page, active.turnId)).toHaveAttribute("data-selected", "true");
  await expect(turnCard(page, backgroundUpdate.turnId)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`[?&]session=${active.sessionId}(?:&|$)`));
});

test("an active near-bottom session follows a newly committed turn", async ({
  page,
  request,
}) => {
  const sessionKey = uniqueKey("near bottom");
  const turns = await publishMany(request, sessionKey, 8, { label: "follow" });
  const latest = turns.at(-1)!;
  await gotoSession(page, latest.sessionId, latest.turnId);
  await scrollTranscriptTo(page, "bottom");

  const appended = await publishTurn(request, {
    document: semanticAnswer("follow appended"),
    requestSummary: "Append while the reader is at the live edge",
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("follow appended"),
  });

  await expect(turnCard(page, appended.turnId)).toBeVisible();
  await expect(turnCard(page, appended.turnId)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("new-turn-banner")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`[?&]turn=${appended.turnId}(?:&|$)`));
  await expect
    .poll(async () => {
      const metrics = await scrollMetrics(page);
      return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
    })
    .toBeLessThan(48);
});

test("an active reader on older content does not jump and can use the new-turn banner", async ({
  page,
  request,
}) => {
  const sessionKey = uniqueKey("older reader");
  const turns = await publishMany(request, sessionKey, 28, { label: "older" });
  const selected = turns.at(-10)!;
  await gotoSession(page, selected.sessionId, selected.turnId);
  await setTranscriptReadingPosition(page, 0.35);
  const before = await visibleTurnAnchor(page);

  const appended = await publishTurn(request, {
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("older appended"),
  });

  await expect(page.getByTestId("new-turn-banner")).toBeVisible();
  await expect(turnCard(page, selected.turnId)).toHaveAttribute("data-selected", "true");
  await expect
    .poll(async () => Math.abs((await anchorOffset(page, before)) - before.top))
    .toBeLessThan(4);

  await page.getByTestId("new-turn-banner").click();
  await expect(turnCard(page, appended.turnId)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("new-turn-banner")).toHaveCount(0);
});

test("prepending an older page preserves the visible scroll anchor", async ({
  page,
  request,
}) => {
  const turns = await publishMany(request, uniqueKey("prepend"), 44, {
    label: "prepend",
  });
  const latest = turns.at(-1)!;
  await gotoSession(page, latest.sessionId, latest.turnId);
  await expect(renderedTurnCards(page)).toHaveCount(20);

  const scroller = page.getByTestId("transcript-scroller");
  await scroller.evaluate((element) => {
    const previousBehavior = element.style.scrollBehavior;
    element.style.scrollBehavior = "auto";
    element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight);
    void element.scrollTop;
    element.style.scrollBehavior = previousBehavior;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(100);

  const anchor = await visibleTurnAnchor(page);

  await page.getByTestId("load-older").evaluate((element: HTMLElement) => element.click());
  await expect(renderedTurnCards(page)).toHaveCount(40);
  await expect
    .poll(async () => Math.abs((await anchorOffset(page, anchor)) - anchor.top))
    .toBeLessThan(4);
});

test("each session restores its own scroll and selection without carrying an open expansion", async ({
  page,
  request,
}) => {
  const firstTurns = await publishMany(request, uniqueKey("reader state A"), 28, {
    label: "state A",
  });
  const secondTurns = await publishMany(request, uniqueKey("reader state B"), 28, {
    label: "state B",
  });
  const first = firstTurns.at(-1)!;
  const second = secondTurns.at(-1)!;

  await gotoSession(page, first.sessionId, first.turnId);
  await zoomAnchor(page, first.turnId, "tradeoff").click();
  await expect(page.getByTestId(`detail-panel-${first.turnId}`)).toBeVisible();
  await setTranscriptReadingPosition(page, 0.45);
  const firstPosition = await visibleTurnAnchor(page);

  await sessionItem(page, second.sessionId).click();
  await expect(turnCard(page, second.turnId)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId(`detail-panel-${first.turnId}`)).toHaveCount(0);
  await setTranscriptReadingPosition(page, 0.25);
  const secondPosition = await visibleTurnAnchor(page);

  await sessionItem(page, first.sessionId).click();
  await expect(page.getByTestId(`detail-panel-${first.turnId}`)).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await anchorOffset(page, firstPosition)) - firstPosition.top))
    .toBeLessThan(16);

  await sessionItem(page, second.sessionId).click();
  await expect
    .poll(async () => Math.abs((await anchorOffset(page, secondPosition)) - secondPosition.top))
    .toBeLessThan(16);
});

test("the closed linear body is readable and word, phrase, sentence, and paragraph-end anchors work", async ({
  page,
  request,
}) => {
  const sessionKey = uniqueKey("turn expansions");
  const older = await publishTurn(request, {
    document: semanticAnswer("older vocabulary", {
      definitionContent: "Definition owned by the older turn.",
    }),
    requestSummary: "The older request summary",
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("older vocabulary"),
  });
  const latest = await publishTurn(request, {
    document: semanticAnswer("latest vocabulary", {
      definitionContent: "Definition owned by the latest turn.",
    }),
    requestSummary: "The latest request summary",
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("latest vocabulary"),
  });

  await gotoSession(page, latest.sessionId, latest.turnId);
  const latestCard = turnCard(page, latest.turnId);
  await expect(latestCard).toContainText("latest vocabulary is a complete answer");
  await expect(latestCard).toContainText("The closed answer remains readable on its own.");
  await expect(latestCard).not.toContainText("latest vocabulary phrase-level supporting detail.");
  await expect(page.getByRole("button", { name: /density|core|annotated|full/i })).toHaveCount(0);

  const ordering = await turnCard(page, latest.turnId).evaluate((card, ids) => {
    const summary = card.querySelector(`[data-testid="${ids.summary}"]`)!;
    const answer = card.querySelector(`[data-testid="${ids.answer}"]`)!;
    return Boolean(summary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, {
    answer: `turn-answer-${latest.turnId}`,
    summary: `turn-summary-${latest.turnId}`,
  });
  expect(ordering).toBe(true);

  await expect(zoomAnchor(page, latest.turnId, "semantic-answer")).toHaveText("concept");
  await expect(zoomAnchor(page, latest.turnId, "tradeoff")).toHaveText(
    "the smallest useful explanation",
  );
  await expect(zoomAnchor(page, latest.turnId, "rationale")).toHaveText(
    "The closed answer remains readable on its own.",
  );
  await expect(zoomAnchor(page, latest.turnId, "more")).toHaveText("More detail");

  await zoomAnchor(page, latest.turnId, "semantic-answer").click();
  await expect(page.getByTestId(`definition-popover-${latest.turnId}`)).toContainText(
    "Definition owned by the latest turn.",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`definition-popover-${latest.turnId}`)).toHaveCount(0);
  await expect(zoomAnchor(page, latest.turnId, "semantic-answer")).toBeFocused();
  await zoomAnchor(page, latest.turnId, "semantic-answer").click();
  await zoomAnchor(page, latest.turnId, "tradeoff").click();
  await expect(page.getByTestId(`definition-popover-${latest.turnId}`)).toHaveCount(0);
  await expect(page.getByTestId(`detail-panel-${latest.turnId}`)).toContainText(
    "latest vocabulary phrase-level supporting detail.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await zoomAnchor(page, latest.turnId, "rationale").click();
  await expect(page.getByTestId(`detail-panel-${latest.turnId}`)).toContainText(
    "latest vocabulary sentence-level supporting detail.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(zoomAnchor(page, latest.turnId, "rationale")).toBeFocused();

  await clickTurn(page, older.turnId);
  await zoomAnchor(page, older.turnId, "semantic-answer").click();
  await expect(page.getByTestId(`definition-popover-${older.turnId}`)).toContainText(
    "Definition owned by the older turn.",
  );
  await expect(page.getByTestId(`definition-popover-${older.turnId}`)).not.toContainText(
    "Definition owned by the latest turn.",
  );
  await page.getByTestId("viewer-title").click({ position: { x: 1, y: 1 } });
  await expect(page.getByTestId(`definition-popover-${older.turnId}`)).toHaveCount(0);
  await expect(zoomAnchor(page, older.turnId, "semantic-answer")).toBeFocused();
});

test("reload and browser history restore explicit session and turn selection", async ({
  page,
  request,
}) => {
  const first = await publishTurn(request, {
    sourceSessionKey: uniqueKey("history A"),
    sourceTurnKey: uniqueKey("history A turn"),
  });
  const second = await publishTurn(request, {
    sourceSessionKey: uniqueKey("history B"),
    sourceTurnKey: uniqueKey("history B turn"),
  });

  await gotoSession(page, first.sessionId, first.turnId);
  await sessionItem(page, second.sessionId).click();
  await expect(page).toHaveURL(new RegExp(`[?&]session=${second.sessionId}(?:&|$)`));
  await expect(turnCard(page, second.turnId)).toHaveAttribute("data-selected", "true");

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`[?&]session=${first.sessionId}(?:&|$)`));
  await expect(turnCard(page, first.turnId)).toHaveAttribute("data-selected", "true");

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`[?&]session=${second.sessionId}(?:&|$)`));
  await page.reload();
  await expect(turnCard(page, second.turnId)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId(`turn-title-${second.turnId}`)).toHaveText(
    second.document.title,
  );
});

test("a deep-linked historical turn opens a contiguous window that can page to latest", async ({
  page,
  request,
}) => {
  const turns = await publishMany(request, uniqueKey("historical deep link"), 70, {
    label: "deep link",
  });
  const selected = turns[9];
  const latest = turns.at(-1)!;
  await gotoSession(page, selected.sessionId, selected.turnId);
  await expect(turnCard(page, selected.turnId)).toHaveAttribute("data-selected", "true");

  const assertContiguousWindow = async () => {
    const sequences = await renderedTurnCards(page).evaluateAll((cards) =>
      cards.map((card) => Number(card.getAttribute("data-sequence"))),
    );
    expect(sequences.length).toBeGreaterThan(1);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index] - sequences[index - 1]).toBe(1);
    }
  };
  await assertContiguousWindow();

  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    if (await turnCard(page, latest.turnId).count()) break;
    const beforeMaximum = await renderedTurnCards(page).evaluateAll((cards) =>
      Math.max(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
    );
    await page.getByTestId("load-newer").click();
    await expect
      .poll(() =>
        renderedTurnCards(page).evaluateAll((cards) =>
          Math.max(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
        ),
      )
      .toBeGreaterThan(beforeMaximum);
    await assertContiguousWindow();
  }
  await expect(turnCard(page, latest.turnId)).toBeVisible();
  expect(await renderedTurnCards(page).count()).toBeLessThanOrEqual(80);
});

test("switching sessions restores an older paged window and its reading anchor", async ({
  page,
  request,
}) => {
  const firstTurns = await publishMany(request, uniqueKey("paged restore A"), 75, {
    label: "paged restore A",
  });
  const second = await publishTurn(request, {
    sourceSessionKey: uniqueKey("paged restore B"),
    sourceTurnKey: uniqueKey("paged restore B turn"),
  });
  const first = firstTurns.at(-1)!;
  await gotoSession(page, first.sessionId, first.turnId);

  for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
    const beforeMinimum = await renderedTurnCards(page).evaluateAll((cards) =>
      Math.min(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
    );
    await page.getByTestId("load-older").click();
    await expect
      .poll(() =>
        renderedTurnCards(page).evaluateAll((cards) =>
          Math.min(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
        ),
      )
      .toBeLessThan(beforeMinimum);
  }
  await setTranscriptReadingPosition(page, 0.3);
  const anchor = await visibleTurnAnchor(page);

  await sessionItem(page, second.sessionId).click();
  await expect(turnCard(page, second.turnId)).toBeVisible();
  await sessionItem(page, first.sessionId).click();
  await expect
    .poll(async () => Math.abs((await anchorOffset(page, anchor)) - anchor.top))
    .toBeLessThan(16);
});

test("an in-flight older-page response cannot mix turns into a newly selected session", async ({
  page,
  request,
}) => {
  const firstTurns = await publishMany(request, uniqueKey("inflight A"), 50, {
    label: "inflight A",
  });
  const secondTurns = await publishMany(request, uniqueKey("inflight B"), 5, {
    label: "inflight B",
  });
  const first = firstTurns.at(-1)!;
  const second = secondTurns.at(-1)!;
  await gotoSession(page, first.sessionId, first.turnId);

  let releaseRequest!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let markIntercepted!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    markIntercepted = resolve;
  });
  await page.route(
    `${apiBaseUrl()}/api/sessions/${first.sessionId}/turns**`,
    async (route) => {
      if (!new URL(route.request().url()).searchParams.has("beforeSequence")) {
        await route.continue();
        return;
      }
      markIntercepted();
      await release;
      await route.continue();
    },
  );

  await page.getByTestId("load-older").click();
  await intercepted;
  await sessionItem(page, second.sessionId).click();
  await expect(turnCard(page, second.turnId)).toHaveAttribute("data-selected", "true");

  const delayedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/sessions/${first.sessionId}/turns` &&
      url.searchParams.has("beforeSequence")
    );
  });
  releaseRequest();
  await delayedResponse;
  await page.waitForTimeout(150);

  await expect(page).toHaveURL(new RegExp(`[?&]session=${second.sessionId}(?:&|$)`));
  const renderedIds = await renderedTurnCards(page).evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-testid")?.slice("turn-".length)),
  );
  const secondIds = new Set(secondTurns.map((turn) => turn.turnId));
  expect(renderedIds.every((turnId) => !!turnId && secondIds.has(turnId))).toBe(true);
  await expect(turnCard(page, first.turnId)).toHaveCount(0);
});

test("a failed near-bottom turn fetch leaves an explicit recovery path", async ({
  page,
  request,
}) => {
  const sessionKey = uniqueKey("failed fetch recovery");
  const turns = await publishMany(request, sessionKey, 6, { label: "recovery" });
  const latest = turns.at(-1)!;
  await gotoSession(page, latest.sessionId, latest.turnId);
  await scrollTranscriptTo(page, "bottom");

  let failedFetches = 0;
  await page.route(`${apiBaseUrl()}/api/turns/**`, async (route) => {
    if (failedFetches === 0) {
      failedFetches += 1;
      await route.fulfill({
        body: JSON.stringify({ ok: false, error: { code: "injected_failure" } }),
        contentType: "application/json",
        status: 503,
      });
      return;
    }
    await route.continue();
  });

  const appended = await publishTurn(request, {
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("failed fetch appended"),
  });
  await expect(page.getByTestId("new-turn-banner")).toBeVisible();
  expect(failedFetches).toBe(1);

  await page.getByTestId("new-turn-banner").click();
  await expect(turnCard(page, appended.turnId)).toBeVisible();
  await expect(turnCard(page, appended.turnId)).toHaveAttribute("data-selected", "true");
});

test("scrolling upward during a delayed live fetch cancels automatic follow", async ({
  page,
  request,
}) => {
  const sessionKey = uniqueKey("delayed follow");
  const turns = await publishMany(request, sessionKey, 15, { label: "delayed follow" });
  const selected = turns.at(-1)!;
  await gotoSession(page, selected.sessionId, selected.turnId);
  await scrollTranscriptTo(page, "bottom");

  let releaseRequest!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let markIntercepted!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    markIntercepted = resolve;
  });
  await page.route(`${apiBaseUrl()}/api/turns/**`, async (route) => {
    markIntercepted();
    await release;
    await route.continue();
  });

  const appended = await publishTurn(request, {
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("delayed follow appended"),
  });
  await intercepted;
  await setTranscriptReadingPosition(page, 0.3);
  const readingAnchor = await visibleTurnAnchor(page);

  const delayedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/turns/${appended.turnId}`;
  });
  releaseRequest();
  await delayedResponse;

  await expect(page.getByTestId("new-turn-banner")).toBeVisible();
  await expect(page.getByTestId(`unread-badge-${selected.sessionId}`)).toContainText("1");
  await expect(turnCard(page, selected.turnId)).toHaveAttribute("data-selected", "true");
  await expect
    .poll(async () => Math.abs((await anchorOffset(page, readingAnchor)) - readingAnchor.top))
    .toBeLessThan(4);

  await page.getByTestId("new-turn-banner").click();
  await expect(turnCard(page, appended.turnId)).toHaveAttribute("data-selected", "true");
});

test("a closed mobile session drawer is outside the keyboard tab order", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ height: 760, width: 390 });
  const first = await publishTurn(request, {
    sourceSessionKey: uniqueKey("mobile first"),
    sourceTurnKey: uniqueKey("mobile first turn"),
  });
  await publishTurn(request, {
    sourceSessionKey: uniqueKey("mobile second"),
    sourceTurnKey: uniqueKey("mobile second turn"),
  });
  await gotoSession(page, first.sessionId, first.turnId);

  const toggle = page.getByRole("button", { name: "Sessions" });
  const sidebar = page.locator("#session-sidebar");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  await page.keyboard.press("Tab");
  expect(await sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(false);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.focus();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => sidebar.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
});

test("Copy body stays linear while Copy complete includes each referenced expansion once", async ({
  context,
  page,
  request,
}) => {
  const document = semanticAnswer("copy answer", {
    definitionContent: "Referenced contextual definition.",
  });
  const turn = await publishTurn(request, {
    document,
    sourceSessionKey: uniqueKey("copy answer"),
    sourceTurnKey: uniqueKey("copy answer turn"),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: viewerBaseUrl(),
  });
  await gotoSession(page, turn.sessionId, turn.turnId);

  await page.getByTestId("copy-body").click();
  const bodyClipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(bodyClipboard).toContain(document.title);
  expect(bodyClipboard).toContain("concept");
  expect(bodyClipboard).not.toContain("zoom:");
  expect(bodyClipboard).not.toContain("Referenced contextual definition.");

  await page.getByTestId("copy-complete").click();
  const completeClipboard = await page.evaluate(() => navigator.clipboard.readText());
  for (const expansion of Object.values(document.expansions!)) {
    expect(completeClipboard.split(expansion.content)).toHaveLength(2);
  }
  expect(completeClipboard).not.toContain("zoom:");
});

test("zoom and copy controls use only the published turn and make no model or content request", async ({
  context,
  page,
  request,
}) => {
  const sessionKey = uniqueKey("offline controls");
  const selected = await publishTurn(request, {
    document: semanticAnswer("selected local content"),
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("selected local content"),
  });
  const latest = await publishTurn(request, {
    document: semanticAnswer("unselected latest content"),
    sourceSessionKey: sessionKey,
    sourceTurnKey: uniqueKey("unselected latest content"),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: viewerBaseUrl(),
  });
  await gotoSession(page, latest.sessionId, selected.turnId);
  await expect(turnCard(page, selected.turnId)).toHaveAttribute("data-selected", "true");

  const interactionRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (["fetch", "xhr", "websocket"].includes(outgoing.resourceType())) {
      interactionRequests.push(outgoing.url());
    }
  });

  await zoomAnchor(page, selected.turnId, "tradeoff").click();
  await expect(page.getByTestId(`detail-panel-${selected.turnId}`)).toBeVisible();
  await zoomAnchor(page, selected.turnId, "semantic-answer").click();
  await expect(page.getByTestId(`definition-popover-${selected.turnId}`)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("copy-body").click();
  await page.getByTestId("copy-complete").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(selected.document.title);
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain(
    latest.document.title,
  );
  await page.waitForTimeout(150);
  expect(interactionRequests).toEqual([]);
});

test("desktop details use a fixed right rail without moving the main reading position or width", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  const turns = await publishMany(request, uniqueKey("fixed detail rail"), 24, {
    label: "fixed rail",
  });
  const selected = turns.at(-1)!;
  await gotoSession(page, selected.sessionId, selected.turnId);
  await setTranscriptReadingPosition(page, 0.4);
  const trigger = zoomAnchor(page, selected.turnId, "more");
  await trigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const before = await scrollMetrics(page);
  const widthBefore = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  await trigger.click();
  const panel = page.getByTestId(`detail-panel-${selected.turnId}`);
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.x).toBeGreaterThan(1280 / 2);
  await expect
    .poll(async () => Math.abs((await scrollMetrics(page)).scrollTop - before.scrollTop))
    .toBeLessThan(4);
  expect(await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual(widthBefore);

  await page.getByTestId("viewer-title").click({ position: { x: 1, y: 1 } });
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("mobile details use a bottom sheet and close with Escape", async ({ page, request }) => {
  await page.setViewportSize({ height: 760, width: 390 });
  const turn = await publishTurn(request, {
    sourceSessionKey: uniqueKey("mobile details"),
    sourceTurnKey: uniqueKey("mobile details turn"),
  });
  await gotoSession(page, turn.sessionId, turn.turnId);
  const trigger = zoomAnchor(page, turn.turnId, "tradeoff");
  await trigger.click();
  const sheet = page.getByTestId(`detail-panel-${turn.turnId}`);
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThan(760 / 2);
  expect(Math.abs(box!.y + box!.height - 760)).toBeLessThan(32);
  expect(box!.width).toBeGreaterThan(340);

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("remote Markdown images are represented without making a remote request", async ({
  context,
  page,
  request,
}) => {
  const remoteUrl = "https://private-canary.invalid/semantic-transcript-pixel.png";
  const attemptedRemoteRequests: string[] = [];
  await context.route("https://private-canary.invalid/**", async (route) => {
    attemptedRemoteRequests.push(route.request().url());
    await route.abort();
  });
  const turn = await publishTurn(request, {
    document: semanticAnswer("remote image", { remoteImageUrl: remoteUrl }),
    sourceSessionKey: uniqueKey("remote image"),
    sourceTurnKey: uniqueKey("remote image turn"),
  });

  await gotoSession(page, turn.sessionId, turn.turnId);
  await expect(turnCard(page, turn.turnId)).toContainText("remote beacon");
  await page.waitForTimeout(250);
  expect(attemptedRemoteRequests).toEqual([]);
});

test("two tabs observe shared commits but keep independent reader positions", async ({
  context,
  page,
  request,
}) => {
  const firstKey = uniqueKey("tab A");
  const secondKey = uniqueKey("tab B");
  const firstTurns = await publishMany(request, firstKey, 30, { label: "tab A" });
  const secondTurns = await publishMany(request, secondKey, 30, { label: "tab B" });
  const first = firstTurns.at(-1)!;
  const second = secondTurns.at(-1)!;
  const secondPage = await context.newPage();

  await gotoSession(page, first.sessionId, first.turnId);
  await gotoSession(secondPage, second.sessionId, second.turnId);
  await setTranscriptReadingPosition(page, 0.25);
  await setTranscriptReadingPosition(secondPage, 0.55);
  const firstBefore = await visibleTurnAnchor(page);
  const secondBefore = await visibleTurnAnchor(secondPage);

  await publishTurn(request, {
    sourceSessionKey: firstKey,
    sourceTurnKey: uniqueKey("tab A update"),
  });
  await publishTurn(request, {
    sourceSessionKey: secondKey,
    sourceTurnKey: uniqueKey("tab B update"),
  });

  await expect(page.getByTestId("new-turn-banner")).toBeVisible();
  await expect(secondPage.getByTestId("new-turn-banner")).toBeVisible();
  await expect(page.getByTestId(`unread-badge-${second.sessionId}`)).toContainText("1");
  await expect(secondPage.getByTestId(`unread-badge-${first.sessionId}`)).toContainText("1");
  await expect
    .poll(async () => Math.abs((await anchorOffset(page, firstBefore)) - firstBefore.top))
    .toBeLessThan(4);
  await expect
    .poll(async () => Math.abs((await anchorOffset(secondPage, secondBefore)) - secondBefore.top))
    .toBeLessThan(4);

  const firstStoredAnchorId = await storedSessionAnchorId(page, first.sessionId);
  const secondStoredAnchorId = await storedSessionAnchorId(secondPage, second.sessionId);
  if (!firstStoredAnchorId || !secondStoredAnchorId) {
    throw new Error("Each tab must persist an active-session turn anchor.");
  }
  expect(firstStoredAnchorId).not.toBe(secondStoredAnchorId);
  const firstStoredAnchor = {
    testId: `turn-${firstStoredAnchorId}`,
    top: await anchorOffset(page, { testId: `turn-${firstStoredAnchorId}`, top: 0 }),
  };
  const secondStoredAnchor = {
    testId: `turn-${secondStoredAnchorId}`,
    top: await anchorOffset(secondPage, { testId: `turn-${secondStoredAnchorId}`, top: 0 }),
  };

  await page.reload();
  await secondPage.reload();
  await expect(sessionItem(page, first.sessionId)).toBeVisible();
  await expect(sessionItem(secondPage, second.sessionId)).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs((await anchorOffset(page, firstStoredAnchor)) - firstStoredAnchor.top),
    )
    .toBeLessThan(24);
  await expect
    .poll(async () =>
      Math.abs((await anchorOffset(secondPage, secondStoredAnchor)) - secondStoredAnchor.top),
    )
    .toBeLessThan(24);
});
