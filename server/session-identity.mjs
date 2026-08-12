export const SEMANTIC_ANSWER_SESSION_KEY_ENV = "SEMANTIC_ANSWER_SESSION_KEY";
export const SEMANTIC_ANSWER_TURN_KEY_ENV = "SEMANTIC_ANSWER_TURN_KEY";

export class MissingSessionIdentityError extends Error {
  constructor() {
    super(
      "No stable source session identity was supplied. Configure the Codex hook or SEMANTIC_ANSWER_SESSION_KEY.",
    );
    this.name = "MissingSessionIdentityError";
    this.code = "missing_session_identity";
  }
}

function presentString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolves explicit integration identity only. It deliberately never derives
 * identity from a process, working directory, browser tab, or "latest" state.
 */
export class SessionIdentityProvider {
  constructor(options = {}) {
    this.environment = options.environment ?? process.env;
  }

  bind(argumentsValue, options = {}) {
    const input = { ...(argumentsValue ?? {}) };
    if (!presentString(input.sourceSessionKey)) {
      const configured = this.environment[SEMANTIC_ANSWER_SESSION_KEY_ENV];
      if (!presentString(configured)) {
        if (options.required === false) {
          return input;
        }
        throw new MissingSessionIdentityError();
      }
      input.sourceSessionKey = configured;
    }
    if (!presentString(input.sourceTurnKey)) {
      const configuredTurn = this.environment[SEMANTIC_ANSWER_TURN_KEY_ENV];
      if (presentString(configuredTurn)) {
        input.sourceTurnKey = configuredTurn;
      }
    }
    return input;
  }
}
