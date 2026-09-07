FROM node:20-slim
WORKDIR /srv
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libgomp1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7600 \
    SEARCH_BACKEND=meilisearch
EXPOSE 7600
# Run as the unprivileged `node` user (port 7600 needs no root). Copy steps
# above run as root, so hand ownership to `node` before dropping privileges.
RUN chown -R node:node /srv
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:7600/health || exit 1
CMD ["node", "dist/server.js"]
