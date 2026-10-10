/**
 * View (remote desktop) — Bun parent.
 * Full X11 capture/input parity requires a seat-user worker (see REVIEW R-002).
 * Status reports discovery; WS accepts JWT clients and advertises incomplete capture
 * rather than faking frames.
 */
import { existsSync, statSync } from "node:fs";
import { appendTrace } from "./trace";

export const FRAME_MAGIC = 0x48425646; // HBVF

export function discoverX11Env(): { display: string; xauthority: string } {
  let display = (
    process.env.HOMEBASE_DISPLAY ||
    process.env.DISPLAY ||
    ""
  ).trim();
  let xauth = (
    process.env.HOMEBASE_XAUTHORITY ||
    process.env.XAUTHORITY ||
    ""
  ).trim();
  if (!display) display = ":0";
  if (!xauth) {
    const home =
      process.env.HOME ||
      (process.getuid?.() === 0 ? "/home/daniel" : process.env.HOME) ||
      "";
    xauth = home ? `${home}/.Xauthority` : "";
  } else if (!existsSync(xauth)) {
    xauth = "/home/daniel/.Xauthority";
  }
  return { display, xauthority: xauth };
}

let clients = 0;

export function viewStatus(): Record<string, unknown> {
  const { display, xauthority } = discoverX11Env();
  const name = display.replace(/^:/, "").split(".")[0] || "0";
  const sock = `/tmp/.X11-unix/X${name}`;
  let error: string | null = null;
  if (!existsSync(sock)) {
    error = `X11 socket missing (${sock})`;
  }
  // Capture worker not yet Bun-native — honest status
  if (!error) {
    error =
      "View capture worker incomplete in Bun backend (see docs/migration/REVIEW_REQUIRED.md R-002)";
  }
  return {
    ok: false,
    display,
    xauthority: existsSync(xauthority) ? xauthority : null,
    screenW: 0,
    screenH: 0,
    monitors: [],
    clients,
    error,
    fps: 0,
    kbps: 0,
  };
}

export function viewClientConnected(): void {
  clients++;
  appendTrace("info", `view client connect (n=${clients})`, "view");
}

export function viewClientDisconnected(): void {
  clients = Math.max(0, clients - 1);
  appendTrace("info", `view client disconnect (n=${clients})`, "view");
}

void statSync;
