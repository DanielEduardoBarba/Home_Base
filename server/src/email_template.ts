/**
 * Home Base–themed multipart email (night UI: deep ink + blue accent).
 * Always include a plain-text part for clients that block HTML.
 */

export type EmailTone = "info" | "warn" | "danger" | "ok";

export type EmailField = { label: string; value: string };

export type EmailPayload = {
  subject: string;
  eyebrow: string;
  title: string;
  lead: string;
  fields?: EmailField[];
  tips?: string[];
  footerNote?: string;
  tone?: EmailTone;
};

const TONE: Record<EmailTone, { bar: string; pillBg: string; pillFg: string }> = {
  info: { bar: "#4da3ff", pillBg: "rgba(77,163,255,0.16)", pillFg: "#7ec8ff" },
  warn: { bar: "#f0b429", pillBg: "rgba(240,180,41,0.16)", pillFg: "#f0b429" },
  danger: { bar: "#f07178", pillBg: "rgba(240,113,120,0.16)", pillFg: "#f07178" },
  ok: { bar: "#5fd68a", pillBg: "rgba(95,214,138,0.16)", pillFg: "#5fd68a" },
};

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildAlertEmail(p: EmailPayload): {
  subject: string;
  text: string;
  html: string;
} {
  const tone = p.tone || "info";
  const colors = TONE[tone];
  const fields = (p.fields || []).filter((f) => f.value);
  const tips = (p.tips || []).filter(Boolean);
  const when = new Date().toUTCString();

  const textLines = [
    `Home Base · ${p.eyebrow}`,
    p.title,
    "",
    p.lead,
    "",
    ...fields.map((f) => `${f.label}: ${f.value}`),
    tips.length ? "" : "",
    ...tips.map((t) => `• ${t}`),
    "",
    p.footerNote || "Sent by Home Base on your laptop. Configure in Settings → Email alerts.",
    when,
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === ""));

  const fieldRows = fields
    .map(
      (f) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #243044;width:34%;vertical-align:top;">
          <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9aabc4;">${esc(f.label)}</span>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #243044;vertical-align:top;">
          <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#f2f5fa;line-height:1.45;">${esc(f.value)}</span>
        </td>
      </tr>`,
    )
    .join("");

  const tipHtml = tips.length
    ? `<div style="margin-top:22px;padding:14px 16px;border-radius:12px;background:#121925;border:1px solid #243044;">
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9aabc4;margin-bottom:8px;">What you can do</div>
        ${tips
          .map(
            (t) =>
              `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#c5d0e0;line-height:1.5;padding:3px 0;">· ${esc(t)}</div>`,
          )
          .join("")}
      </div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(p.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#05070c;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#05070c;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#0c111a;border:1px solid #243044;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:4px;background:${colors.bar};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px 28px;">
              <div style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:18px;font-weight:800;letter-spacing:-0.03em;color:#f2f5fa;">
                Home Base
              </div>
              <div style="margin-top:14px;display:inline-block;padding:5px 10px;border-radius:999px;background:${colors.pillBg};">
                <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${colors.pillFg};">${esc(p.eyebrow)}</span>
              </div>
              <h1 style="margin:16px 0 0 0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.03em;color:#f2f5fa;">
                ${esc(p.title)}
              </h1>
              <p style="margin:12px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#9aabc4;">
                ${esc(p.lead)}
              </p>
            </td>
          </tr>
          ${
            fields.length
              ? `<tr>
            <td style="padding:8px 28px 0 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${fieldRows}</table>
            </td>
          </tr>`
              : ""
          }
          <tr>
            <td style="padding:8px 28px 28px 28px;">
              ${tipHtml}
              <p style="margin:22px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.5;color:#6b7c94;">
                ${esc(p.footerNote || "Sent by Home Base on your laptop · Settings → Email alerts")}
                <br/>
                <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;">${esc(when)}</span>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: p.subject,
    text: textLines.join("\n"),
    html,
  };
}
