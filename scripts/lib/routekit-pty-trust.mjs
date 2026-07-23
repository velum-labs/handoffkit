const TRUST_PROMPT =
  /Workspace Trust Required|Do you trust(?: the contents of)?|trust this (?:folder|workspace)|project you created/i;
const TRUST_IN_PROGRESS = /Trusting workspace/i;
const TRUST_KEY =
  /\[\s*([A-Za-z0-9])\s*\]\s*(?:Trust(?: this)? (?:workspace|folder)|Yes,?\s+I trust(?: this)? (?:workspace|folder)|Continue)/i;
const TRUST_ENTER =
  /(?:press\s+(?:the\s+)?(?:enter|return).{0,40}(?:trust|continue)|(?:trust|continue).{0,40}\[\s*(?:enter|return)\s*\]|\[\s*(?:enter|return)\s*\].{0,40}(?:trust|continue))/i;

export function cursorWorkspaceTrustDecision(transcript, options = {}) {
  if (options.ready === true) return { state: "ready", action: undefined };
  if (TRUST_IN_PROGRESS.test(transcript)) {
    return { state: "transitioning", action: undefined };
  }
  if (!TRUST_PROMPT.test(transcript)) {
    return { state: "absent", action: undefined };
  }

  const key = transcript.match(TRUST_KEY)?.[1];
  if (key !== undefined) {
    return {
      state: "prompt",
      action: { type: "literal", value: key }
    };
  }
  if (TRUST_ENTER.test(transcript)) {
    return {
      state: "prompt",
      action: { type: "key", value: "Enter" }
    };
  }
  return { state: "unsupported", action: undefined };
}
