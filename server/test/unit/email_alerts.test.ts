import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("email_alerts config", () => {
  test("public meta never returns secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "hb-email-"));
    const runtime = join(root, ".runtime");
    mkdirSync(runtime, { recursive: true });
    process.env.HOMEBASE_HOME = root;

    // Re-import after HOMEBASE_HOME so config paths resolve under tmp.
    // Modules already cache RUNTIME_DIR at load — exercise save via dynamic path isolation
    // by writing files the module expects when HOMEBASE_HOME is set before import in a subprocess.
    const script = `
      import { saveEmailAlerts, emailAlertsPublic, clearEmailAlertSecrets } from "./src/email_alerts.ts";
      const saved = saveEmailAlerts({
        enabled: true,
        provider: "resend",
        to: "you@example.com",
        from: "Home Base <alerts@example.com>",
        resendApiKey: "re_test_secret_key_abcdef",
      });
      if (JSON.stringify(saved).includes("re_test_secret")) throw new Error("leaked key");
      if (!saved.resendConfigured) throw new Error("expected configured");
      if (!saved.ready) throw new Error("expected ready");
      const cleared = clearEmailAlertSecrets();
      if (cleared.resendConfigured) throw new Error("expected cleared");
      console.log("ok");
    `;
    writeFileSync(join(root, "run.mjs"), ""); // placeholder
    const proc = Bun.spawn({
      cmd: ["bun", "-e", script],
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        HOMEBASE_HOME: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out).toContain("ok");
    if (code !== 0) expect(err).toBe("");
  });
});
