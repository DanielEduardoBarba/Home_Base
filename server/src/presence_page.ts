/** Self-contained presence desktop window HTML (Chromium --app). */

export function presencePageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Home Base · Presence</title>
<style>
  :root {
    --bg: #0b1220;
    --panel: #121a2b;
    --line: #243049;
    --text: #e8eefc;
    --mute: #8b9bb8;
    --sky: #4da3ff;
    --warn: #f0b429;
    --ok: #3ecf8e;
    --ai: #7c5cff;
    --human: #3db8ff;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    background: radial-gradient(120% 80% at 50% -10%, #1a2744 0%, var(--bg) 55%);
    color: var(--text);
    font: 13px/1.45 "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  }
  .wrap { display: flex; flex-direction: column; height: 100%; padding: 12px; gap: 10px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  header h1 { margin: 0; font-size: 14px; letter-spacing: 0.02em; }
  .pill {
    font-size: 11px; padding: 3px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--mute);
  }
  .pill.on { color: var(--warn); border-color: #6a5218; background: #2a220e; }
  .stage {
    flex: 1; min-height: 160px; overflow: auto;
    display: flex; flex-wrap: wrap; gap: 10px; align-content: flex-start;
  }
  .card {
    width: calc(50% - 5px); min-width: 140px;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; padding: 10px; position: relative;
  }
  .card.ai { border-color: #3a2f6e; }
  .card.human { border-color: #1e4a6e; }
  .avatar { width: 72px; height: 72px; margin: 0 auto 6px; }
  .name { text-align: center; font-weight: 700; font-size: 12px; }
  .label { text-align: center; color: var(--mute); font-size: 10px; }
  .bubble {
    margin-top: 8px; padding: 6px 8px; border-radius: 10px;
    background: #0e1626; color: var(--text); font-size: 11px;
    min-height: 28px; border: 1px solid var(--line);
  }
  .mood {
    position: absolute; top: 8px; right: 8px;
    font-size: 10px; color: var(--mute); text-transform: uppercase;
  }
  .chat {
    border: 1px solid var(--line); border-radius: 12px; background: var(--panel);
    display: flex; flex-direction: column; height: 180px;
  }
  .chat-log { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .msg { font-size: 11px; padding: 6px 8px; border-radius: 8px; max-width: 92%; }
  .msg.operator { align-self: flex-end; background: #1a3355; }
  .msg.ai { align-self: flex-start; background: #241a45; }
  .msg.system { align-self: center; background: transparent; color: var(--mute); font-size: 10px; }
  .chat-form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--line); }
  .chat-form input {
    flex: 1; border-radius: 8px; border: 1px solid var(--line);
    background: #0e1626; color: var(--text); padding: 8px 10px; outline: none;
  }
  .chat-form button {
    border: 0; border-radius: 8px; background: var(--sky); color: #041018;
    font-weight: 700; padding: 0 12px; cursor: pointer;
  }
  .empty { color: var(--mute); font-size: 12px; padding: 24px 8px; text-align: center; width: 100%; }
  .hint { color: var(--mute); font-size: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Home Base · Remotes</h1>
    <span class="pill" id="status">…</span>
  </header>
  <p class="hint">Visible whenever a person (Web GUI) or AI (MCP) is remoted in. You cannot be silent.</p>
  <div class="stage" id="stage"></div>
  <div class="chat">
    <div class="chat-log" id="log"></div>
    <form class="chat-form" id="form">
      <input id="input" placeholder="Message AI agents…" autocomplete="off" maxlength="500"/>
      <button type="submit">Send</button>
    </form>
  </div>
</div>
<script>
const params = new URLSearchParams(location.search);
const k = params.get("k") || "";
const stage = document.getElementById("stage");
const logEl = document.getElementById("log");
const status = document.getElementById("status");
let lastChat = 0;

function humanSvg() {
  return '<svg class="avatar" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">'
    + '<circle cx="36" cy="36" r="34" fill="#102033" stroke="#3db8ff" stroke-width="2"/>'
    + '<circle cx="36" cy="28" r="11" fill="#7ec8ff"/>'
    + '<path d="M18 58c4-12 14-16 18-16s14 4 18 16" fill="#3db8ff"/>'
    + '</svg>';
}
function aiSvg(mood) {
  const eye = mood === "thinking" ? 3 : mood === "alert" ? 5 : 4;
  return '<svg class="avatar" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">'
    + '<circle cx="36" cy="36" r="34" fill="#16102a" stroke="#7c5cff" stroke-width="2"/>'
    + '<rect x="18" y="22" width="36" height="28" rx="10" fill="#2a1f55"/>'
    + '<circle cx="28" cy="34" r="'+eye+'" fill="#cbb8ff"/>'
    + '<circle cx="44" cy="34" r="'+eye+'" fill="#cbb8ff"/>'
    + '<path d="M28 44c3 3 13 3 16 0" stroke="#9b84ff" stroke-width="2" fill="none" stroke-linecap="round"/>'
    + '<path d="M36 10v8M28 12l4 6M44 12l-4 6" stroke="#7c5cff" stroke-width="2" stroke-linecap="round"/>'
    + '</svg>';
}

function renderActors(actors) {
  if (!actors.length) {
    stage.innerHTML = '<div class="empty">No remotes — window will close when idle.</div>';
    status.textContent = "idle";
    status.classList.remove("on");
    return;
  }
  status.textContent = actors.length + " active";
  status.classList.add("on");
  stage.innerHTML = actors.map(a => {
    const cls = a.kind === "ai" ? "ai" : "human";
    const svg = a.kind === "ai" ? aiSvg(a.mood) : humanSvg();
    const bubble = a.bubble ? a.bubble : (a.kind === "ai" ? "(no expression yet)" : "Viewing Home Base");
    return '<div class="card '+cls+'">'
      + '<div class="mood">'+a.mood+'</div>'
      + svg
      + '<div class="name"></div><div class="label"></div><div class="bubble"></div>'
      + '</div>';
  }).join("");
  [...stage.querySelectorAll(".card")].forEach((el, i) => {
    const a = actors[i];
    el.querySelector(".name").textContent = a.name;
    el.querySelector(".label").textContent = a.label + (a.peerIp ? " · " + a.peerIp : "");
    el.querySelector(".bubble").textContent = a.bubble || (a.kind === "ai" ? "(no expression yet)" : "Viewing Home Base");
  });
}

function appendChat(msgs) {
  for (const m of msgs) {
    if (m.at <= lastChat) continue;
    lastChat = Math.max(lastChat, m.at);
    const div = document.createElement("div");
    div.className = "msg " + m.from;
    div.textContent = (m.from === "ai" ? (m.actorName || "AI") + ": " : m.from === "operator" ? "You: " : "") + m.text;
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

async function tick() {
  try {
    const res = await fetch("/api/presence/ui?k=" + encodeURIComponent(k));
    if (!res.ok) throw new Error("auth");
    const data = await res.json();
    renderActors(data.actors || []);
    appendChat(data.chat || []);
  } catch (e) {
    status.textContent = "error";
  }
}

document.getElementById("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await fetch("/api/presence/ui/chat?k=" + encodeURIComponent(k), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  tick();
});

tick();
setInterval(tick, 1500);
</script>
</body>
</html>`;
}
