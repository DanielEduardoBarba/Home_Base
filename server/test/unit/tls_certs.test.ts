import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tls_certs helpers", () => {
  const prevRuntime = process.env.HOMEBASE_RUNTIME;
  const prevHttps = process.env.HOMEBASE_HTTPS_PORT;
  let tmp: string | null = null;

  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.HOMEBASE_RUNTIME;
    else process.env.HOMEBASE_RUNTIME = prevRuntime;
    if (prevHttps === undefined) delete process.env.HOMEBASE_HTTPS_PORT;
    else process.env.HOMEBASE_HTTPS_PORT = prevHttps;
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      tmp = null;
    }
  });

  test("httpsPort respects off / default", async () => {
    // Fresh import after env — use dynamic path via already-loaded module functions
    const { httpsPort } = await import("../../src/tls_certs");
    delete process.env.HOMEBASE_HTTPS_PORT;
    expect(httpsPort()).toBe(8443);
    process.env.HOMEBASE_HTTPS_PORT = "0";
    expect(httpsPort()).toBe(0);
    process.env.HOMEBASE_HTTPS_PORT = "off";
    expect(httpsPort()).toBe(0);
    process.env.HOMEBASE_HTTPS_PORT = "9443";
    expect(httpsPort()).toBe(9443);
  });

  test("ensureLocalTlsCerts creates CA + server material under runtime", async () => {
    tmp = mkdtempSync(join(tmpdir(), "hb-tls-"));
    process.env.HOMEBASE_RUNTIME = tmp;
    // Re-import is cached — call ensure against paths derived from env by re-reading module
    // The module binds TLS_DIR at load from RUNTIME_DIR. Use spawn to isolate.
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `
        process.env.HOMEBASE_RUNTIME = ${JSON.stringify(tmp)};
        const m = await import("./src/tls_certs.ts");
        const r = m.ensureLocalTlsCerts();
        if (!r.ok) { console.error(r.error); process.exit(1); }
        console.log(JSON.stringify({ created: r.created, present: m.tlsMaterialPresent(), status: m.tlsStatusPublic() }));
        `,
      ],
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(err).toBe("");
    const j = JSON.parse(out.trim()) as {
      created: boolean
      present: boolean
      status: { materialPresent: boolean; caDownloadPath: string }
    };
    expect(j.created).toBe(true);
    expect(j.present).toBe(true);
    expect(j.status.materialPresent).toBe(true);
    expect(j.status.caDownloadPath).toBe("/api/tls/ca.crt");
    expect(existsSync(join(tmp, "tls", "ca.crt"))).toBe(true);
    expect(existsSync(join(tmp, "tls", "server.key"))).toBe(true);
    expect(existsSync(join(tmp, "tls", "server.crt"))).toBe(true);
  });
});
