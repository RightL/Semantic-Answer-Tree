import { expect, test } from "@playwright/test";

import {
  gotoSession,
  publishMany,
  renderedTurnCards,
  sessionItem,
  uniqueKey,
  zoomAnchor,
} from "../browser/fixtures";

test("hundreds of turns stay paginated, bounded, lazy, and interactive", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const deepCanary = `DEEP-NOT-MOUNTED-${uniqueKey("canary")}`;
  const largeSessionKey = uniqueKey("large history");
  const backgroundKeys = [
    uniqueKey("performance background one"),
    uniqueKey("performance background two"),
    uniqueKey("performance background three"),
  ];

  const [largeTurns, ...backgroundTurnSets] = await Promise.all([
    publishMany(request, largeSessionKey, 360, {
      concurrency: 16,
      deepCanary,
      label: "large history",
    }),
    ...backgroundKeys.map((sessionKey, index) =>
      publishMany(request, sessionKey, 40, {
        concurrency: 12,
        deepCanary,
        label: `background ${index + 1}`,
      }),
    ),
  ]);
  const latest = largeTurns.at(-1)!;

  const navigationStarted = Date.now();
  await gotoSession(page, latest.sessionId, latest.turnId);
  const navigationDuration = Date.now() - navigationStarted;
  expect(navigationDuration).toBeLessThan(8_000);

  const initialCardCount = await renderedTurnCards(page).count();
  expect(initialCardCount).toBeGreaterThanOrEqual(15);
  expect(initialCardCount).toBeLessThanOrEqual(25);
  await expect(page.getByText(deepCanary, { exact: true })).toHaveCount(0);

  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const beforeMinimumSequence = await renderedTurnCards(page).evaluateAll((cards) =>
      Math.min(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
    );
    await page.getByTestId("load-older").evaluate((element: HTMLElement) => element.click());
    await expect
      .poll(() =>
        renderedTurnCards(page).evaluateAll((cards) =>
          Math.min(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
        ),
      )
      .toBeLessThan(beforeMinimumSequence);
    expect(await renderedTurnCards(page).count()).toBeLessThanOrEqual(80);
  }

  // Expansion content stays out of the rendered transcript while closed.
  await expect(page.getByText(deepCanary, { exact: true })).toHaveCount(0);
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    if (await page.getByTestId(`turn-${latest.turnId}`).count()) break;
    const beforeMaximumSequence = await renderedTurnCards(page).evaluateAll((cards) =>
      Math.max(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
    );
    await page.getByTestId("load-newer").evaluate((element: HTMLElement) => element.click());
    await expect
      .poll(() =>
        renderedTurnCards(page).evaluateAll((cards) =>
          Math.max(...cards.map((card) => Number(card.getAttribute("data-sequence")))),
        ),
      )
      .toBeGreaterThan(beforeMaximumSequence);
    expect(await renderedTurnCards(page).count()).toBeLessThanOrEqual(80);
  }
  await expect(page.getByTestId(`turn-${latest.turnId}`)).toBeVisible();
  await zoomAnchor(page, latest.turnId, "more").click();
  await expect(page.getByText(deepCanary, { exact: true }).last()).toBeVisible();
  await zoomAnchor(page, latest.turnId, "semantic-answer").click();
  await expect(page.getByTestId(`definition-popover-${latest.turnId}`)).toBeVisible();

  const backgroundLatest = backgroundTurnSets[0].at(-1)!;
  await sessionItem(page, backgroundLatest.sessionId).click();
  await expect(page.getByTestId(`turn-${backgroundLatest.turnId}`)).toBeVisible();
  expect(await renderedTurnCards(page).count()).toBeLessThanOrEqual(25);
});
