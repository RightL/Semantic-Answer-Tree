import { expect, test } from "@playwright/test";

import { apiBaseUrl, renderedTurnCards, viewerBaseUrl } from "./fixtures";

test("an empty live transcript replaces the bundled demo state", async ({ page }) => {
  await page.route(`${apiBaseUrl()}/api/sessions`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ sessions: [] }),
    });
  });

  await page.goto(viewerBaseUrl());

  await expect(page.getByText("Live local transcript", { exact: true })).toBeVisible();
  await expect(page.locator(".sidebar-heading")).toContainText("0");
  await expect(page.getByTestId("session-list").getByRole("button")).toHaveCount(0);
  await expect(renderedTurnCards(page)).toHaveCount(0);
  await expect(page.getByTestId("viewer-title")).toHaveText("Semantic transcript");
  await expect(page.getByRole("heading", { name: "No turns yet" })).toBeVisible();
});
