// server.js — Wickwood storybook server
//
// Runs the whole app on one port:
//   GET  /                  → public/index.html (the React app)
//   GET  /config            → small JSON config for the frontend
//   GET  /<anything else>   → static files from public/
//   POST /llm/*             → ${GMI_MAAS_BASE_URL}/*
//   POST /queue/*           → ${GMI_QUEUE_BASE_URL}/*
//   GET  /queue/*           → ${GMI_QUEUE_BASE_URL}/*
//
// Same-origin everything → no CORS in the browser.
// Zero dependencies — Node 18+ built-in http + fetch.
//
// AgentBox / MaaS support:
//   When GMI_MAAS_API_KEY is set (e.g. injected by GMI AgentBox at runtime),
//   the server attaches it to all outbound requests and the frontend hides
//   the API-key input. When it's not set (local dev), the frontend asks the
//   user for their key the old way. The same image works in both modes.
//
//   When GMI_MODELS is set, the LLM `model` field in /llm/v1/chat/completions
//   bodies is rewritten to it, so the agent always calls the model the operator
//   approved in the registration wizard, regardless of what the frontend sends.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");

// ── GMI configuration (env-driven, with sensible defaults for local dev) ──
const GMI_MAAS_BASE_URL = (process.env.GMI_MAAS_BASE_URL || "https://api.gmi-serving.com").replace(/\/$/, "");
const GMI_MAAS_API_KEY = process.env.GMI_MAAS_API_KEY || "";
const GMI_QUEUE_BASE_URL = (process.env.GMI_QUEUE_BASE_URL || "https://console.gmicloud.ai").replace(/\/$/, "");

// ── Model resolution ────────────────────────────────────────
// AgentBox's MaaS injection sometimes sets GMI_MODELS to an internal UUID
// like "16e9ccd2-84e0-43b4-9d9a-5cb31b3341a2" rather than a model slug.
// The chat-completions endpoint can't resolve UUIDs, so we:
//   1. Honor WICKWOOD_MODEL first (distinct name, not touched by injection)
//   2. Honor GMI_MODELS if it looks like a real slug (has a "/" and isn't a UUID)
//   3. Otherwise fall back to a default slug and warn loudly
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL = "openai/gpt-5.5";

function resolveModel() {
  const override = (process.env.WICKWOOD_MODEL || "").trim();
  if (override) return { value: override, source: "WICKWOOD_MODEL" };

  const fromMaas = (process.env.GMI_MODELS || "").trim();
  if (fromMaas && !UUID_RE.test(fromMaas)) {
    return { value: fromMaas, source: "GMI_MODELS" };
  }
  if (fromMaas && UUID_RE.test(fromMaas)) {
    console.warn("");
    console.warn(`  ⚠️  GMI_MODELS was injected as a UUID (${fromMaas}).`);
    console.warn(`     The chat-completions API needs a model slug like "${DEFAULT_MODEL}".`);
    console.warn(`     Set WICKWOOD_MODEL=<slug> as a plain env var to override.`);
    console.warn(`     Falling back to "${DEFAULT_MODEL}" for now.`);
    console.warn("");
    return { value: DEFAULT_MODEL, source: "fallback (UUID detected)" };
  }
  return { value: DEFAULT_MODEL, source: "default" };
}

const { value: GMI_MODELS, source: GMI_MODELS_SOURCE } = resolveModel();

const HAS_INJECTED_AUTH = GMI_MAAS_API_KEY.length > 0;

const PROXY_TARGETS = {
  "/llm": GMI_MAAS_BASE_URL,
  "/queue": GMI_QUEUE_BASE_URL,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ──────────────────────────────────────────────────────────────
// Proxy helper
// ──────────────────────────────────────────────────────────────
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "origin",
  "referer",
]);

async function handleProxy(prefix, req, res) {
  const target = PROXY_TARGETS[prefix];
  const upstreamUrl = target + req.url.slice(prefix.length);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks);

  // Build forwarded headers
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }

  // Inject the operator's MaaS key when configured. We always overwrite so
  // the agent owner pays — the public endpoint on AgentBox shouldn't let
  // callers hand-roll their own credentials.
  if (HAS_INJECTED_AUTH) {
    headers["authorization"] = `Bearer ${GMI_MAAS_API_KEY}`;
  }

  // Lock the LLM model to GMI_MODELS so we don't burn budget on arbitrary
  // models the frontend might request. Only rewrite chat/completions bodies.
  if (
    prefix === "/llm" &&
    req.method === "POST" &&
    req.url.includes("/chat/completions") &&
    body.length > 0
  ) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      if (parsed && typeof parsed === "object") {
        parsed.model = GMI_MODELS;
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      /* body wasn't JSON, forward as-is */
    }
  }

  const start = Date.now();
  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    const elapsed = Date.now() - start;
    console.log(`  → ${req.method} ${upstreamUrl} → ${upstream.status} (${elapsed}ms)`);

    res.statusCode = upstream.status;
    upstream.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (kl === "content-encoding") return;
      if (kl === "content-length") return;
      if (kl === "transfer-encoding") return;
      res.setHeader(k, v);
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error(`  → proxy error: ${e.message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: e.message }));
  }
}

// ──────────────────────────────────────────────────────────────
// /config — frontend asks us which model + whether to show key UI
// ──────────────────────────────────────────────────────────────
function handleConfig(req, res) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({
    model: GMI_MODELS,
    hasInjectedAuth: HAS_INJECTED_AUTH,
    maasBaseUrl: GMI_MAAS_BASE_URL,
  }));
}

// ──────────────────────────────────────────────────────────────
// Static file helper (with path safety)
// ──────────────────────────────────────────────────────────────
function serveStatic(urlPath, res) {
  const safePath = path
    .normalize(urlPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath || "index.html");

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(PUBLIC_DIR, "index.html");
      fs.readFile(fallback, (err2, data) => {
        if (err2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ──────────────────────────────────────────────────────────────
// Main server
// ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);

  // /config (small JSON, no auth)
  if (req.method === "GET" && req.url === "/config") {
    return handleConfig(req, res);
  }

  // Proxy prefixes
  for (const prefix of Object.keys(PROXY_TARGETS)) {
    if (
      req.url === prefix ||
      req.url.startsWith(prefix + "/") ||
      req.url.startsWith(prefix + "?")
    ) {
      return handleProxy(prefix, req, res);
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("method not allowed");
    return;
  }

  const urlPath = req.url.split("?")[0];
  serveStatic(urlPath === "/" ? "/index.html" : urlPath, res);
});

// Listen on 0.0.0.0 so the container is reachable from outside its network namespace
server.listen(PORT, "0.0.0.0", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  🌲  Wickwood is ready`);
  console.log(`      open ${url} in your browser`);
  console.log(`      Ctrl+C to stop\n`);
  console.log(`  Configuration:`);
  console.log(`    MaaS base URL : ${GMI_MAAS_BASE_URL}`);
  console.log(`    Queue base URL: ${GMI_QUEUE_BASE_URL}`);
  console.log(`    LLM model     : ${GMI_MODELS}  (from ${GMI_MODELS_SOURCE})`);
  console.log(`    MaaS key      : ${HAS_INJECTED_AUTH ? "injected ✓" : "not set (users will provide)"}`);
  console.log("");
});
