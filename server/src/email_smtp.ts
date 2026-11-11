/**
 * Minimal SMTP client (AUTH LOGIN + optional STARTTLS / implicit TLS).
 * Used only by email_alerts — no third-party mailer dependency.
 */
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

export type SmtpSendOpts = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  timeoutMs?: number;
};

type Conn = Socket | TLSSocket;

function encodeLogin(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function b64Subject(subject: string): string {
  // RFC 2047 for non-ASCII; keep ASCII plain.
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

async function readReply(sock: Conn): Promise<{ code: number; lines: string[] }> {
  let buf = "";
  for (;;) {
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      const onData = (d: Buffer) => {
        cleanup();
        resolve(d);
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(e);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("SMTP connection closed"));
      };
      const cleanup = () => {
        sock.off("data", onData);
        sock.off("error", onErr);
        sock.off("close", onClose);
      };
      sock.on("data", onData);
      sock.on("error", onErr);
      sock.on("close", onClose);
    });
    buf += chunk.toString("utf8");
    const lines = buf.split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) continue;
    const last = lines[lines.length - 1]!;
    // Multi-line: "250-…" then final "250 …"
    if (/^\d{3}-/.test(last)) continue;
    const m = last.match(/^(\d{3})[\s-]/);
    if (!m) continue;
    return { code: Number(m[1]), lines };
  }
}

function writeLine(sock: Conn, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()));
  });
}

function openSocket(opts: {
  host: string;
  port: number;
  tls: boolean;
  timeoutMs: number;
}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const onSock = (sock: Conn) => {
      sock.setTimeout(opts.timeoutMs);
      sock.once("timeout", () => {
        sock.destroy();
        reject(new Error("SMTP timeout"));
      });
      resolve(sock);
    };
    if (opts.tls) {
      const s = tlsConnect(
        { host: opts.host, port: opts.port, servername: opts.host },
        () => onSock(s),
      );
      s.once("error", reject);
    } else {
      const s = connect({ host: opts.host, port: opts.port }, () => onSock(s));
      s.once("error", reject);
    }
  });
}

function upgradeTls(sock: Socket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect(
      { socket: sock, host, servername: host },
      () => {
        s.setTimeout(timeoutMs);
        resolve(s);
      },
    );
    s.once("error", reject);
  });
}

export async function smtpSend(opts: SmtpSendOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const host = opts.host.trim();
  const port = opts.port;
  if (!host || !port) throw new Error("SMTP host/port required");
  if (!opts.to.trim()) throw new Error("SMTP to required");
  if (!opts.from.trim()) throw new Error("SMTP from required");

  let sock: Conn = await openSocket({
    host,
    port,
    tls: opts.secure,
    timeoutMs,
  });

  const expect = async (ok: number | number[], cmd?: string) => {
    if (cmd != null) await writeLine(sock, cmd);
    const reply = await readReply(sock);
    const codes = Array.isArray(ok) ? ok : [ok];
    if (!codes.includes(reply.code)) {
      throw new Error(
        `SMTP ${cmd?.split(" ")[0] || "banner"} → ${reply.lines.join(" | ")}`,
      );
    }
    return reply;
  };

  try {
    await expect(220);
    await expect(250, `EHLO homebase`);
    if (!opts.secure && port !== 465) {
      // STARTTLS when available
      try {
        await expect(220, "STARTTLS");
        sock = await upgradeTls(sock as Socket, host, timeoutMs);
        await expect(250, `EHLO homebase`);
      } catch {
        // Some servers (e.g. port 25 local) have no STARTTLS — continue.
      }
    }
    if (opts.user) {
      await expect(334, "AUTH LOGIN");
      await expect(334, encodeLogin(opts.user));
      await expect(235, encodeLogin(opts.pass));
    }
    await expect(250, `MAIL FROM:<${opts.from}>`);
    await expect(250, `RCPT TO:<${opts.to}>`);
    await expect(354, "DATA");
    const date = new Date().toUTCString();
    const text = opts.text.replace(/\r?\n/g, "\r\n");
    const html = opts.html?.replace(/\r?\n/g, "\r\n");
    const headers = [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${b64Subject(opts.subject)}`,
      `Date: ${date}`,
      `MIME-Version: 1.0`,
    ];
    let payload: string;
    if (html) {
      const boundary = `hb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      payload = [
        ...headers,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        text,
        `--${boundary}`,
        `Content-Type: text/html; charset=utf-8`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        html,
        `--${boundary}--`,
        `.`,
      ].join("\r\n");
    } else {
      payload = [
        ...headers,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: 8bit`,
        ``,
        text,
        `.`,
      ].join("\r\n");
    }
    await writeLine(sock, payload);
    await expect(250);
    await expect([221, 250], "QUIT").catch(() => undefined);
  } finally {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  }
}
