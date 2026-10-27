# syntax=docker/dockerfile:1

# Base image pinned by tag AND digest: reproducible builds, and Dependabot
# keeps both up to date.
ARG NODE_IMAGE=node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# --- Stage 1: production dependencies only ---------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# --- Stage 2: runtime image -------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Build metadata goes last so changing the commit does not invalidate the
# dependency and source layers above it.
ARG APP_VERSION=""
ARG GIT_SHA="unknown"
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

LABEL org.opencontainers.image.revision=${GIT_SHA}

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["node", "src/server.js"]
