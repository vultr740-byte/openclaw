type ParsedCanonicalSessionKey = {
  agentId: string;
  rest: string;
};

export function normalizeSessionKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseCanonicalSessionKey(value: string): ParsedCanonicalSessionKey | null {
  const normalized = normalizeSessionKey(value);
  if (!normalized.startsWith("agent:")) {
    return null;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") {
    return null;
  }
  const agentId = parts[1]?.trim() ?? "";
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) {
    return null;
  }
  return { agentId, rest };
}

export function sessionKeysMatch(a: string, b: string): boolean {
  const left = normalizeSessionKey(a);
  const right = normalizeSessionKey(b);
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const leftCanonical = parseCanonicalSessionKey(left);
  const rightCanonical = parseCanonicalSessionKey(right);
  if (leftCanonical && rightCanonical) {
    return (
      leftCanonical.agentId === rightCanonical.agentId && leftCanonical.rest === rightCanonical.rest
    );
  }
  if (leftCanonical) {
    return leftCanonical.rest === right;
  }
  if (rightCanonical) {
    return rightCanonical.rest === left;
  }
  return false;
}
