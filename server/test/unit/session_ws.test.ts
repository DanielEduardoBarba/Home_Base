import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "hb-session-ws-"));
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
process.env.HOMEBASE_HOME = root;
process.env.HOMEBASE_RUNTIME = runtime;

const { RUNTIME_DIR } = await import("../../src/config");
const auth = await import("../../src/auth");
const { app, authenticateWsToken } = await import("../../src/app");
const tickets = await import("../../src/ws_tickets");
const cookies = await import("../../src/session_cookie");

function envIsolated(): boolean {
  return RUNTIME_DIR.startsWith(root);
}
const describeIso = envIsolated() ? describe : describe.skip;

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const PASSWORD = "Session-ws-test-pass-ok-1!";

function setCookieLines(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function lineFor(res: Response, name: string): string | undefined {
  return setCookieLines(res).find((l) => l.toLowerCase().startsWith(`${name}=`.toLowerCase()));
}


function cookieJar(res: Response): string {
  return setCookieLines(res)
    .map((l) => l.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

function flags(line: string | undefined): { httpOnly: boolean; secure: boolean; sameSite: string; path: string } {
  const parts = (line || "").split(";").map((s) => s.trim());
  const attrs = new Map<string, string>();
  for (const p of parts.slice(1)) {
    const [k, v] = p.split("=", 2);
    if (!k) continue;
    attrs.set(k.toLowerCase(), v ?? "");
  }
  return {
    httpOnly: parts.some((p) => p.toLowerCase() === "httponly"),
    secure: parts.some((p) => p.toLowerCase() === "secure"),
    sameSite: attrs.get("samesite") || "",
    path: attrs.get("path") || "",
  };
}

async function login(url: string, extraHeaders?: Record<string, string>): Promise<Response> {
  return app.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(extraHeaders || {}),
      },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
}

describeIso("session cookies, CSRF, and WebSocket tickets", () => {
  test("setup password once", () => {
    auth.bootstrapPassword(PASSWORD);
    expect(auth.passwordIsSet()).toBe(true);
  });

  test("login over http sets HttpOnly SameSite=Strict session cookie without Secure", async () => {
    const res = await login("http://127.0.0.1/api/login");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; csrfToken?: string; expiresAt?: number };
    expect(typeof body.token).toBe("string");
    expect(body.token!.length).toBeGreaterThan(16);
    expect(typeof body.csrfToken).toBe("string");

    const sessionLine = lineFor(res, cookies.SESSION_COOKIE);
    const csrfLine = lineFor(res, cookies.CSRF_COOKIE);
    expect(sessionLine).toBeTruthy();
    expect(csrfLine).toBeTruthy();
    const s = flags(sessionLine);
    const x = flags(csrfLine);
    expect(s.httpOnly).toBe(true);
    expect(s.sameSite.toLowerCase()).toBe("strict");
    expect(s.path).toBe("/");
    expect(s.secure).toBe(false);
    expect(x.httpOnly).toBe(false);
    expect(x.sameSite.toLowerCase()).toBe("strict");
    expect(x.path).toBe("/");
    expect(x.secure).toBe(false);
  });

  test("login over https sets Secure on both cookies", async () => {
    const res = await login("https://homebase.example/api/login");
    expect(res.status).toBe(200);
    expect(flags(lineFor(res, cookies.SESSION_COOKIE)).secure).toBe(true);
    expect(flags(lineFor(res, cookies.CSRF_COOKIE)).secure).toBe(true);
    expect(flags(lineFor(res, cookies.SESSION_COOKIE)).httpOnly).toBe(true);
    expect(flags(lineFor(res, cookies.CSRF_COOKIE)).httpOnly).toBe(false);
    expect(flags(lineFor(res, cookies.SESSION_COOKIE)).sameSite.toLowerCase()).toBe("strict");
  });

  test("X-Forwarded-Proto https from a trusted proxy marks cookies Secure", async () => {
    const prev = process.env.HOMEBASE_TRUSTED_PROXIES;
    process.env.HOMEBASE_TRUSTED_PROXIES = "10.0.0.1";
    try {
      const res = await login("http://10.6.0.1/api/login", {
        "x-homebase-peer": "10.0.0.1",
        "x-forwarded-proto": "https",
      });
      expect(res.status).toBe(200);
      expect(flags(lineFor(res, cookies.SESSION_COOKIE)).secure).toBe(true);
    } finally {
      if (prev == null) delete process.env.HOMEBASE_TRUSTED_PROXIES;
      else process.env.HOMEBASE_TRUSTED_PROXIES = prev;
    }
  });

  test("CSRF rejects missing or mismatched tokens and accepts a double-submit match", async () => {
    const res = await login("http://127.0.0.1/api/login");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { csrfToken: string };
    const jar = cookieJar(res);

    const missing = await app.fetch(
      new Request("http://127.0.0.1/api/ws-ticket", {
        method: "POST",
        headers: { cookie: jar, "content-type": "application/json" },
      }),
    );
    expect(missing.status).toBe(403);
    const missingBody = (await missing.json()) as { detail?: { code?: string } };
    expect(missingBody.detail?.code).toBe("csrf");

    const bad = await app.fetch(
      new Request("http://127.0.0.1/api/ws-ticket", {
        method: "POST",
        headers: {
          cookie: jar,
          "content-type": "application/json",
          "x-csrf-token": "definitely-not-the-csrf-token-value-xxxx",
        },
      }),
    );
    expect(bad.status).toBe(403);
    const badBody = (await bad.json()) as { detail?: { code?: string } };
    expect(badBody.detail?.code).toBe("csrf");

    const ok = await app.fetch(
      new Request("http://127.0.0.1/api/ws-ticket", {
        method: "POST",
        headers: {
          cookie: jar,
          "content-type": "application/json",
          "x-csrf-token": body.csrfToken,
        },
      }),
    );
    expect(ok.status).toBe(200);
    const minted = (await ok.json()) as { ticket: string; expiresIn: number };
    expect(minted.ticket.length).toBeGreaterThan(16);
    expect(minted.expiresIn).toBeLessThanOrEqual(30);
    expect(minted.expiresIn).toBeGreaterThan(0);
  });

  test("legacy Bearer clients skip CSRF and still reach authenticated routes", async () => {
    const issued = await auth.issueJwt({ kind: "session" });
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/ws-ticket", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.token}`,
          "content-type": "application/json",
        },
      }),
    );
    expect(res.status).toBe(200);
    const minted = (await res.json()) as { ticket: string };
    expect(minted.ticket.length).toBeGreaterThan(16);

    const status = await app.fetch(
      new Request("http://127.0.0.1/api/app-pin/status", {
        headers: { authorization: `Bearer ${issued.token}` },
      }),
    );
    expect(status.status).toBe(200);
  });

  test("query-string JWT is rejected for HTTP API auth", async () => {
    const issued = await auth.issueJwt({ kind: "session" });
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/app-pin/status?token=${encodeURIComponent(issued.token)}`),
    );
    expect(res.status).toBe(401);
  });

  test("WebSocket ticket redeems once, rejects reuse and expiry; Bearer still works; query JWT does not", async () => {
    tickets.resetWsTicketsForTest();
    const issued = await auth.issueJwt({ kind: "session" });
    const claims = await auth.decodeJwt(issued.token);

    const minted = tickets.mintWsTicket(claims);
    const ok = await authenticateWsToken(
      new URL(`ws://127.0.0.1/ws/view?ticket=${minted.ticket}`),
      new Headers(),
    );
    expect(ok).toBe(true);
    const reuse = await authenticateWsToken(
      new URL(`ws://127.0.0.1/ws/view?ticket=${minted.ticket}`),
      new Headers(),
    );
    expect(reuse).toBe(false);

    const short = tickets.mintWsTicket(claims, { ttlMs: 5 });
    await Bun.sleep(20);
    const expired = await authenticateWsToken(
      new URL(`ws://127.0.0.1/ws/view?ticket=${short.ticket}`),
      new Headers(),
    );
    expect(expired).toBe(false);

    const bearerOk = await authenticateWsToken(
      new URL("ws://127.0.0.1/ws/view"),
      new Headers({ authorization: `Bearer ${issued.token}` }),
    );
    expect(bearerOk).toBe(true);

    const queryJwt = await authenticateWsToken(
      new URL(`ws://127.0.0.1/ws/view?token=${encodeURIComponent(issued.token)}`),
      new Headers(),
    );
    expect(queryJwt).toBe(false);
  });

  test("GET /api/auth/session restores csrf from a session cookie and anonymous is not authenticated", async () => {
    const res = await login("http://127.0.0.1/api/login");
    const jar = cookieJar(res);
    const session = await app.fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: { cookie: jar } }),
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as { authenticated: boolean; csrfToken?: string };
    expect(body.authenticated).toBe(true);
    expect(typeof body.csrfToken).toBe("string");

    const anon = await app.fetch(new Request("http://127.0.0.1/api/auth/session"));
    expect(anon.status).toBe(200);
    const anonBody = (await anon.json()) as { authenticated: boolean };
    expect(anonBody.authenticated).toBe(false);
  });
});
