/**
 * Central secret redaction for every log / trace / activity / notification path.
 * Key-based (callbackAuth, Authorization, token, apiKey, password, secret, …)
 * plus value-based Bearer / MCP / JWT / PEM patterns.
 * Never a substitute for not writing secrets in the first place.
 */
const SENSITIVE_KEY =
  /^(callback[_-]?auth|authorization|auth|token|api[_-]?key|apiKey|password|passwd|pwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key|bearer)$/i;

const KEY_VALUE_RE =
  /(?:password|passwd|pwd|secret|api[_-]?key|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|callback[_-]?auth|authorization|token)\s*[=:]\s*(?:Bearer\s+)?\S+/gi;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(String(key || ""));
}

/** Strip known secret *values* from a string. */
export function redactSecrets(text: string): string {
  let s = String(text || "");
  s = s.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted]",
  );
  // Bearer / JWT / MCP tokens first so "callbackAuth=Bearer <token>" cannot
  // leave the token behind after a key=value match stops at the first space.
  s = s.replace(/\bBearer\s+\S+/gi, "[redacted]");
  s = s.replace(/hb_mcp_[A-Za-z0-9_\-]+/g, "[redacted]");
  s = s.replace(
    /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
    "[redacted]",
  );
  s = s.replace(KEY_VALUE_RE, "[redacted]");
  return s;
}

export function redactDeep(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, k);
    }
    return out;
  }
  return value;
}

export function redactFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!fields) return fields;
  return redactDeep(fields) as Record<string, unknown>;
}
