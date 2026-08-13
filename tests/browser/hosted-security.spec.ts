import { expect, test } from "@playwright/test";

const hostedUrl = process.env.SEMANTIC_TRANSCRIPT_HOSTED_URL;

test("hosted CSP blocks script attributes while hydrated interactions remain functional", async ({
  page,
}) => {
  test.skip(!hostedUrl, "Set SEMANTIC_TRANSCRIPT_HOSTED_URL after a Sites deployment.");

  const response = await page.goto(hostedUrl!);
  expect(response?.ok()).toBe(true);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");

  await expect(page.getByTestId("turn-demo-placement-003")).toBeVisible();
  await page.getByTestId("zoom-anchor-demo-placement-003-placement-contract").click();
  await expect(page.getByTestId("detail-panel-demo-placement-003")).toBeVisible();
  await page.getByTestId("zoom-anchor-demo-placement-003-placement-revision").click();
  await expect(page.getByTestId("definition-popover-demo-placement-003")).toBeVisible();
});
