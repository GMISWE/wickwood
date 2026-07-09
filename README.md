# Wickwood 🌲✨

A storybook studio for little dreamers. Type any idea — we write a wholesome picture book for kids ages 3–8, paint every page, and read it aloud. Powered by GMI Cloud.

Two ways to run it: **locally** on your laptop (you bring your own GMI API key), or **deployed on GMI AgentBox** (GMI injects the key, end users just use the agent).

---

## Run it locally

You need Node.js 18+ and a GMI Cloud API key.

If you got a zip, **extract it first** — you can't run files from inside a zip.

- **Windows:** right-click `wickwood.zip` → Extract All → Extract
- **Mac:** double-click `wickwood.zip`

Then:

```bash
cd wickwood
node server.js
```

You'll see:

```
  🌲  Wickwood is ready
      open http://localhost:8787 in your browser
```

Open the link. Paste your GMI API key, type a story idea, pick a page count, hit **Begin the story**.

To stop: `Ctrl+C` in the terminal. To run on a different port: `PORT=3000 node server.js` (or `$env:PORT=3000; node server.js` in Windows PowerShell).

---

## Deploy on GMI AgentBox

Wickwood is built to drop into the [AgentBox register-an-agent wizard](https://docs.gmicloud.ai/agentbox-marketplace/register-an-agent). The container reads `GMI_MAAS_API_KEY`, `GMI_MAAS_BASE_URL`, and `GMI_MODELS` from env at startup; AgentBox injects them when MaaS integration is enabled in Step 2 of the wizard. When the server sees `GMI_MAAS_API_KEY`, the frontend automatically hides its "magic key" input — end users just bring a story idea.

### 1. Build and push the Docker image

From the `wickwood/` directory on your Mac. **One-time setup** (if you haven't pushed to Docker Hub from this machine before):

```bash
docker login
# Username: gracedeng87
# Password: <your Docker Hub password or access token>
```

**Build for amd64 from Apple Silicon and push in one step** (AgentBox runs amd64):

```bash
docker buildx build --platform=linux/amd64 \
  -t docker.io/gracedeng87/wickwood:latest \
  --push .
```

That's the only command you need. If `buildx` isn't set up yet, do this once:

```bash
docker buildx create --name multibuilder --use
docker buildx inspect --bootstrap
```

Then re-run the build command above.

**Verify the image is on Docker Hub** by visiting <https://hub.docker.com/r/gracedeng87/wickwood> or pulling it back down:

```bash
docker pull gracedeng87/wickwood:latest
```

**Test the image locally before registering it on AgentBox** (this runs the amd64 image via emulation on your Mac; the container listens on 8080 internally, mapped to 8787 on your host):

```bash
docker run --rm -p 8787:8080 \
  -e GMI_MAAS_API_KEY=sk-your-real-key \
  -e GMI_MODELS=openai/gpt-5.5 \
  gracedeng87/wickwood:latest
```

Open <http://localhost:8787> — the magic-key input should be hidden, and the storybook UI should work end-to-end. If it does, you're ready for AgentBox.

### 2. Walk the register wizard

Open the GMI Cloud console → **Agent Marketplace** → **Register & List**.

**Step 1 — Basic Info**
- Internal project name: `wickwood` (or whatever you like)
- Pick "Self-hosted + MaaS" only if you want to host elsewhere; otherwise use **GMI CE Deployment** so GMI runs the container.

**Step 2 — Infrastructure**
- Docker image source: **Registry URL**
- Registry URL: `docker.io/gracedeng87/wickwood:latest`
- Compute tier: **Standard** (2 vCPU / 4 GB RAM is more than enough — Wickwood holds basically nothing in memory)
- Region: **IOWA IDC-1** is the default for AgentBox CE deployments; pick whatever's closest
- **Port mapping: 443 → 8080** (this is AgentBox's default and matches what the container listens on)
- **MaaS integration: ON**
- Models to enable: pick one LLM (e.g. `openai/gpt-5.5` or `deepseek-ai/DeepSeek-V3.2`). This becomes `GMI_MODELS`.

**Step 3 — Env Variables**
You don't need to add anything manually — GMI fills in:
- `GMI_MAAS_BASE_URL` → `https://api.gmi-serving.com`
- `GMI_MAAS_API_KEY` → injected at runtime (never visible)
- `GMI_MODELS` → whatever you selected in Step 2

Optional plain values you might set:
- `WICKWOOD_MODEL` — **set this if `GMI_MODELS` arrives as a UUID** (see Troubleshooting). Value is a slug like `openai/gpt-5.5` or `deepseek-ai/DeepSeek-V3.2`. This takes precedence over `GMI_MODELS`.
- `GMI_QUEUE_BASE_URL` — only set this if GMI changes the queue host (default `https://console.gmicloud.ai`)
- `PORT` — defaults to 8080 inside the container, matches AgentBox's default port mapping. Only override if you change the port mapping.

**Step 4 — Review & Register**
Register. AgentBox pulls the image and gives you a public URL. Open that URL in a browser — Wickwood should come up without asking for an API key.

### Test the deployed endpoint

After Step 4, AgentBox shows a test panel. Just open the agent URL in a normal browser — Wickwood is a web app, so the test is "load it and make a story." If pages don't paint, check the container logs in the AgentBox console; every upstream request gets logged with its URL and status code.

---

## The three inputs

Whether local or deployed, the user gives Wickwood three things:

1. **Your magic key** — only shown in local-dev mode (hidden when AgentBox injects credentials)
2. **Your story idea** — describe a theme or character, or hit "surprise me"
3. **How many pages** — chip selector from 3 to 10

### How the loading works

After the story is written, the reader opens immediately with every page in a loading state. Image and audio generation for every page run in parallel — **page 1 becomes readable as soon as page 1's pieces are ready**, even while pages 5–10 are still cooking. The progress bar at the top shows which pages are done.

---

## What's under the hood

Three GMI models do the work:

- **LLM** (set by `GMI_MODELS`, defaults to `openai/gpt-5.5`) — writes the kid-safe story. Anything iffy in the input gets gently reinterpreted into something age-appropriate.
- **`gpt-image-2-generate`** — paints one watercolor illustration per page
- **`minimax-tts-speech-02-hd`** — narrates each page with the `English_expressive_narrator` voice

The illustration and narration models are hardcoded in `public/index.html` since they go through GMI's queue API rather than MaaS. The LLM model is set by env var so AgentBox operators can pick which model their agent calls.

### Project layout

```
wickwood/
├── package.json       # metadata, no deps
├── server.js          # static server + GMI proxy, reads env vars
├── Dockerfile         # for AgentBox / any container host
├── .dockerignore
├── README.md
└── public/
    └── index.html     # React app (CDN React + Tailwind + Babel)
```

### Architecture

```
Browser ──► server.js ──► api.gmi-serving.com (LLM)
              │       └──► console.gmicloud.ai  (image + audio queue)
              │
              └─ on AgentBox, injects Authorization header from
                 GMI_MAAS_API_KEY and rewrites the LLM `model` field
                 in chat-completions requests to whatever GMI_MODELS says
```

The server is a static-file host + thin GMI proxy in one Node process. Everything is same-origin from the browser's perspective, so there's never a CORS issue. The proxy targets are configurable via `GMI_MAAS_BASE_URL` and `GMI_QUEUE_BASE_URL` env vars; the LLM model gets overridden server-side so the frontend can't burn budget on models the operator didn't approve.

Zero npm dependencies. The whole app is four files.

### A note on long-running requests

[AgentBox's long-running-requests guidance](https://docs.gmicloud.ai/agentbox-marketplace/handle-long-running-requests) recommends 202 + polling for tasks >30s. Wickwood mostly avoids this because each individual HTTP request through the proxy is short:

- The image and audio queues are already async — submit returns immediately, browser polls for status.
- The only sync call is the LLM (5–30s typically), comfortably under most gateway timeouts.

If the LLM call ever does hit a 504, the cleanest fix is wrapping `/llm/v1/chat/completions` in the async-job pattern from the GMI docs. Not necessary for V1.

---

## Troubleshooting

**Server starts but browser can't reach it (local)** → Make sure you're really inside the extracted folder, not the zip. Check the terminal — does it say "Wickwood is ready"?

**On AgentBox, page loads but `/config` returns `hasInjectedAuth: false`** → MaaS integration wasn't enabled in Step 2. Re-register with the toggle on.

**404 "No matching target server found for model `<UUID>`"** → AgentBox's MaaS injection sometimes sets `GMI_MODELS` to an internal UUID rather than a model slug. The chat-completions endpoint can't resolve UUIDs. The server now detects this and falls back to a default slug (`openai/gpt-5.5`) with a loud warning in the container logs. If you want to use a different model, set `WICKWOOD_MODEL` as a plain env var in the AgentBox console (e.g. `WICKWOOD_MODEL=deepseek-ai/DeepSeek-V3.2`) and restart the instance. Check `/config` in your browser to confirm — `model` should show the slug, not a UUID.

**401 / 403 from GMI** → If you're local, your API key. If deployed, check that MaaS integration is enabled and the agent has access to the model you set as `GMI_MODELS` (or `WICKWOOD_MODEL`).

**A page failed to paint or narrate** → That single page shows a friendly fallback. Other pages keep loading normally.

**LLM returns something weird** → Re-run. The prompt is strict but models occasionally wander, especially with smaller models.

---

## License

Do whatever you want with it.
