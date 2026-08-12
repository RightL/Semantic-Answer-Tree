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

  await expect(page.getByTestId("turn-demo-reader-003")).toBeVisible();
  await page.getByTestId("disclosure-demo-reader-003-0").click();
  await expect(page.getByTestId("node-demo-reader-003-0-0")).toBeVisible();
  await page.getByTestId("term-demo-reader-003-semantic-answer-tree").click();
  await expect(page.getByTestId("term-popover-demo-reader-003")).toBeVisible();
});
