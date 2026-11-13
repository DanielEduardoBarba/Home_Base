/**
 * Read-only tail of a PTY/session ring, with secrets redacted.
 */
import { readSessionOutput } from "./pty";
import { redactSecrets } from "./security_log";

export const SESSION_OUTPUT_MAX_LINES = 500;
export const SESSION_OUTPUT_DEFAULT_LINES = 200;

export function takeLastLines(text: string, lines: number): string {
  const cap = Math.min(
    SESSION_OUTPUT_MAX_LINES,
    Math.max(1, Math.floor(Number(lines) || SESSION_OUTPUT_DEFAULT_LINES)),
  );
  const raw = String(text || "");
  const parts = raw.split(/\r?\n/);
  if (parts.length <= cap) return raw;
  return parts.slice(-cap).join("\n");
}

export type SessionOutputResult = {
  projectId: string;
  sessionId: string;
  lines: number;
  output: string;
  alive: boolean;
  title: string;
  redacted: true;
  error?: string;
};

export function homebaseSessionOutput(opts: {
  projectId: string;
  sessionId: string;
  lines?: number;
}): SessionOutputResult | { error: string } {
  const projectId = String(opts.projectId || "").trim();
  const sessionId = String(opts.sessionId || "").trim();
  if (!projectId) return { error: "projectId required" };
  if (!sessionId) return { error: "sessionId required" };
  const lines = Math.min(
    SESSION_OUTPUT_MAX_LINES,
    Math.max(1, Math.floor(Number(opts.lines) || SESSION_OUTPUT_DEFAULT_LINES)),
  );
  const rec = readSessionOutput(sessionId);
  if (!rec || rec.projectId !== projectId) {
    return { error: "session not found" };
  }
  return {
    projectId,
    sessionId,
    lines,
    output: redactSecrets(takeLastLines(rec.output, lines)),
    alive: rec.alive,
    title: rec.title,
    redacted: true,
  };
}
