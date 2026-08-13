import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true });

/**
 * @typedef {object} ZoomReference
 * @property {string} id
 * @property {string} label
 * @property {boolean} hasRenderedText
 * @property {number} index
 * @property {number} length
 */

function sourceOffset(point) {
  return point && Number.isSafeInteger(point.offset) ? point.offset : null;
}

function renderedLabel(markdown, node) {
  const renderedChildren = Array.isArray(node.children)
    ? node.children.filter((child) => child?.type !== "raw")
    : [];
  if (renderedChildren.length === 0) return "";

  const first = renderedChildren[0];
  const last = renderedChildren[renderedChildren.length - 1];
  const start = sourceOffset(first.position?.start);
  const end = sourceOffset(last.position?.end);
  return start !== null && end !== null ? markdown.slice(start, end) : "";
}

function renderedText(node) {
  if (!node || typeof node !== "object" || node.type === "raw") return "";
  if (node.type === "text") return typeof node.value === "string" ? node.value : "";
  if (node.type === "element" && node.tagName === "img") return "Image not loaded";
  return Array.isArray(node.children) ? node.children.map(renderedText).join("") : "";
}

export function expansionIdFromZoomHref(href) {
  const encodedId = href.slice("zoom:".length);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

/**
 * Recognize the same rendered Markdown links as ReactMarkdown with remark-gfm,
 * remark-math, and skipHtml. Raw HTML is left as raw HAST and therefore never
 * visited as an anchor.
 *
 * @param {string} markdown
 * @returns {ZoomReference[]}
 */
export function extractZoomReferences(markdown) {
  const parsed = markdownProcessor.parse(markdown);
  const tree = markdownProcessor.runSync(parsed);
  /** @type {ZoomReference[]} */
  const references = [];

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "element" && node.tagName === "a") {
      const href = typeof node.properties?.href === "string" ? node.properties.href : "";
      const start = sourceOffset(node.position?.start);
      const end = sourceOffset(node.position?.end);
      if (href.startsWith("zoom:") && start !== null && end !== null) {
        references.push({
          id: expansionIdFromZoomHref(href),
          label: renderedLabel(markdown, node),
          hasRenderedText: renderedText(node).trim().length > 0,
          index: start,
          length: end - start,
        });
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  }

  visit(tree);
  return references;
}
