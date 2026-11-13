/**
 * `sudo homebase unlock` — root-only clear of the human (and optional MCP) lockout.
 * Logs a lockout_cleared event and emails (or reports the recipient gap).
 */
import { unlockFromCli, flushLockoutEmails } from "./lockout_recovery";

export type UnlockCliIo = {
  uid?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

export function parseUnlockArgs(argv: string[]): {
  help: boolean;
  includeMcp: boolean;
  unknown: string[];
} {
  const args = argv.filter((a) => a !== "unlock");
  const unknown: string[] = [];
  let help = false;
  let includeMcp = false;
  for (const a of args) {
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--mcp" || a === "--all") includeMcp = true;
    else if (a === "--") continue;
    else unknown.push(a);
  }
  return { help, includeMcp, unknown };
}

function effectiveUid(override?: number): number | undefined {
  if (typeof override === "number") return override;
  try {
    if (typeof process.getuid === "function") return process.getuid();
  } catch {
    /* ignore */
  }
  return undefined;
}

export async function runUnlockCli(
  argv: string[],
  io: UnlockCliIo = {},
): Promise<number> {
  const log = io.log || ((line: string) => console.log(line));
  const err = io.error || ((line: string) => console.error(line));
  const parsed = parseUnlockArgs(argv);
  if (parsed.help) {
    log("Usage: sudo homebase unlock [--mcp|--all]");
    log("Clear the human login/PIN lockout file.");
    log("  --mcp, --all   also clear MCP token lockouts");
    return 0;
  }
  if (parsed.unknown.length) {
    err(`homebase unlock: unknown argument: ${parsed.unknown.join(" ")}`);
    err("Usage: sudo homebase unlock [--mcp|--all]");
    return 2;
  }
  const uid = effectiveUid(io.uid);
  if (uid !== undefined && uid !== 0) {
    err("homebase unlock: must be run as root (sudo homebase unlock)");
    return 1;
  }

  const result = unlockFromCli({ includeMcp: parsed.includeMcp });
  await flushLockoutEmails();

  if (!result.human.cleared && result.mcpSourcesCleared === 0) {
    log(`No active lockout to clear (${result.lockoutPath}).`);
    if (parsed.includeMcp) log(`MCP lockout file: ${result.mcpLockoutPath}`);
    return 0;
  }

  if (result.human.cleared) {
    const until = result.human.previousLockedUntil
      ? new Date(result.human.previousLockedUntil * 1000).toISOString()
      : "n/a";
    log(
      `Cleared human lockout at ${result.lockoutPath} (previous failCount=${result.human.previousFailCount}, lockedUntil=${until}).`,
    );
  } else {
    log(`Human lockout was already clear (${result.lockoutPath}).`);
  }
  if (parsed.includeMcp) {
    log(
      `Cleared ${result.mcpSourcesCleared} MCP lockout source${result.mcpSourcesCleared === 1 ? "" : "s"} (${result.mcpLockoutPath}).`,
    );
  }
  log("Recorded lockout_cleared (method=cli_unlock) in the security log.");
  if (result.emailed) {
    log("Sent a lockout-cleared email alert.");
  } else {
    log(
      `Email alert was not sent: ${result.emailGap || "no email recipient configured"}. The clear is still recorded in the security log.`,
    );
  }
  return 0;
}
