export const VIEWER_SUCCESS_FINAL = "Rendered in Semantic Answer Tree.";

/** Return one final surface: the fixed viewer acknowledgment or an ordinary answer. */
export function finalResponseForPublication(publicationSucceeded, ordinaryFallbackAnswer) {
  if (publicationSucceeded === true) {
    return VIEWER_SUCCESS_FINAL;
  }
  if (typeof ordinaryFallbackAnswer !== "string" || ordinaryFallbackAnswer.trim().length === 0) {
    throw new TypeError("A non-empty ordinary fallback answer is required after publication failure.");
  }
  return ordinaryFallbackAnswer;
}
