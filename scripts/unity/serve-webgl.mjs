#!/usr/bin/env node
/**
 * Tiny static WebGL server: bind VPN/wg0 (or HB_WEBGL_BIND / 127.0.0.1),
 * version endpoint, inject reload poller into index.html. Never defaults to 0.0.0.0.
 * When Builds/WebGL/index.html is missing, serves a clear placeholder page.
 */
import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
} from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { resolveWebglBind } from "./webgl-bind.mjs";

const port = Number(process.env.UNITY_WEBGL_PORT || 8410);
const root = resolve(process.env.UNITY_WEBGL_DIR || "Builds/WebGL");
const host = resolveWebglBind();

try {
  mkdirSync(root, { recursive: true });
} catch {
  /* ignore */
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".mem": "application/octet-stream",
  ".symbols.json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".unityweb": "application/octet-stream",
  ".br": "application/octet-stream",
  ".gz": "application/octet-stream",
};

const PLACEHOLDER = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>No WebGL build yet</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: #0b0d10; color: #e8eaed;
  }
  main { max-width: 22rem; padding: 1.5rem; text-align: center; }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0; line-height: 1.45; color: #9aa0a6; font-size: 0.95rem; }
  code { color: #c4c7c5; }
</style>
</head>
<body>
<main>
  <h1>No WebGL build yet</h1>
  <p>Run <strong>Build WebGL</strong> on the Home Base project card<br/>(or <code>webgl_build</code> / live view).</p>
</main>
<script data-hb-webgl-reload="1">
(function(){
  var v=null;
  function tick(){
    fetch("/__hb_webgl_v",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
      if(v===null){v=j.v;return}
      if(j&&j.v&&j.v!==v){location.reload()}
    }).catch(function(){});
  }
  setInterval(tick,1500);
  tick();
})();
</script>
</body>
</html>`;

let buildStamp = stampNow();

function hasBuild() {
  try {
    return existsSync(join(root, "index.html"));
  } catch {
    return false;
  }
}

function stampNow() {
  try {
    const index = join(root, "index.html");
    if (existsSync(index)) return String(statSync(index).mtimeMs);
  } catch {
    /* ignore */
  }
  return hasBuild() ? String(Date.now()) : "placeholder";
}

function refreshStamp() {
  buildStamp = stampNow();
}

try {
  watch(root, { recursive: true }, () => {
    refreshStamp();
  });
} catch {
  /* recursive watch may fail on some FS — poll stamp on each request instead */
}

const POLLER = `
<script data-hb-webgl-reload="1">
(function(){
  var v=null;
  function tick(){
    fetch("/__hb_webgl_v",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
      if(v===null){v=j.v;return}
      if(j&&j.v&&j.v!==v){location.reload()}
    }).catch(function(){});
  }
  setInterval(tick,1500);
  tick();
})();
</script>
`;

function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent((reqPath || "/").split("?")[0]);
  const cleaned = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = resolve(base, "." + (cleaned.startsWith("/") ? cleaned : "/" + cleaned));
  if (!abs.startsWith(base + sep) && abs !== base) return null;
  return abs;
}

function contentType(file) {
  if (file.endsWith(".js.gz") || file.endsWith(".wasm.gz") || file.endsWith(".data.gz")) {
    return MIME[extname(file.replace(/\.gz$/, ""))] || "application/octet-stream";
  }
  if (file.endsWith(".js.br") || file.endsWith(".wasm.br") || file.endsWith(".data.br")) {
    return MIME[extname(file.replace(/\.br$/, ""))] || "application/octet-stream";
  }
  return MIME[extname(file)] || "application/octet-stream";
}

function sendFile(res, file) {
  const st = statSync(file);
  const headers = {
    "Content-Type": contentType(file),
    "Content-Length": st.size,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  };
  if (file.endsWith(".gz")) headers["Content-Encoding"] = "gzip";
  if (file.endsWith(".br")) headers["Content-Encoding"] = "br";
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

function sendPlaceholder(res) {
  const buf = Buffer.from(PLACEHOLDER, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "X-HomeBase-WebGL": "placeholder",
  });
  res.end(buf);
}

const server = createServer((req, res) => {
  refreshStamp();
  const url = req.url || "/";
  if (url.startsWith("/__hb_webgl_v")) {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ v: buildStamp, build: hasBuild() }));
    return;
  }

  if (!hasBuild()) {
    sendPlaceholder(res);
    return;
  }

  let file = safeJoin(root, url === "/" ? "/index.html" : url);
  if (!file) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const asIndex = join(file, "index.html");
    if (existsSync(asIndex)) file = asIndex;
    else {
      res.writeHead(404).end("not found");
      return;
    }
  }

  if (file.endsWith("index.html")) {
    let html = readFileSync(file, "utf8");
    if (!html.includes("data-hb-webgl-reload")) {
      html = html.includes("</body>")
        ? html.replace("</body>", `${POLLER}</body>`)
        : html + POLLER;
    }
    const buf = Buffer.from(html, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": buf.length,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
    return;
  }

  try {
    sendFile(res, file);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

server.listen(port, host, () => {
  const mode = hasBuild() ? "build" : "placeholder";
  console.log(`hb-webgl listening on http://${host}:${port}/ (${mode}; dir ${root})`);
});
