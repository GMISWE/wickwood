# syntax=docker/dockerfile:1
# Wickwood storybook agent — for GMI AgentBox or any container host.
#
# Build & push for AgentBox (cross-platform from Apple Silicon → amd64):
#   docker login                                    # one-time
#   docker buildx build --platform=linux/amd64 \
#     -t docker.io/gracedeng87/wickwood:latest \
#     --push .
#
# Build locally for testing (native architecture):
#   docker build -t gracedeng87/wickwood:latest .
#   docker run --rm -p 8787:8080 \
#     -e GMI_MAAS_API_KEY=sk-xxx \
#     -e GMI_MODELS=openai/gpt-5.5 \
#     gracedeng87/wickwood:latest
# (then open http://localhost:8787 in your browser)
#
# In AgentBox the env vars are injected automatically when MaaS is enabled.

FROM node:20-alpine

WORKDIR /app

# Copy package.json first so this layer caches between source-only edits.
COPY package.json ./

# No dependencies to install — the app uses Node's built-in http + fetch.
# (If you ever add deps, swap this for `npm ci --omit=dev`.)

# App sources
COPY server.js ./
COPY public ./public

# Drop root for runtime
USER node

# AgentBox routes external traffic (443) to internal port 8080 by default,
# so the container needs to listen on 8080. Override with -e PORT=<n> for
# local testing on a different port.
ENV PORT=8080
EXPOSE 8080

# Lightweight healthcheck against the /config endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:${PORT}/config || exit 1

# exec form so SIGTERM reaches Node and the container shuts down cleanly
CMD ["node", "server.js"]
