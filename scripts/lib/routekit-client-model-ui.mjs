export function nativeDoorModel(door, model) {
  if (door === "codex" && model.startsWith("codex/")) {
    return model.slice("codex/".length);
  }
  if (door !== "claude") return model;
  const pickerId = model.startsWith("claude-code/")
    ? model.slice("claude-code/".length)
    : model;
  return pickerId.startsWith("claude") || pickerId.startsWith("anthropic")
    ? pickerId
    : `claude-${pickerId}`;
}

function claudeDisplayName(model) {
  const native = nativeDoorModel("claude", model);
  const match =
    /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)$/i.exec(native);
  if (match === null) return undefined;
  const family = `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}`;
  return `${family} ${match[2].replaceAll("-", ".")}`;
}

export function modelVisible(transcript, door, model) {
  const candidates = [
    model,
    nativeDoorModel(door, model),
    ...(door === "claude" ? [claudeDisplayName(model)] : [])
  ].filter((candidate) => candidate !== undefined);
  if (
    candidates.some(
      (candidate) =>
        transcript.includes(candidate) ||
        transcript.includes(`${candidate.slice(0, 24)}…`)
    )
  ) {
    return true;
  }
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  const native = model.slice(separator + 1);
  return (
    transcript.includes(door === "claude" ? `claude-${provider}/` : `${provider}/`) &&
    transcript.includes(native.slice(0, 8))
  );
}

export function modelMatchesRequest(requested, door, expected) {
  return requested === expected || requested === nativeDoorModel(door, expected);
}
