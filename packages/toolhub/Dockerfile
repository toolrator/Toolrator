FROM node:20-slim AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

FROM node:20-slim
WORKDIR /srv
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libgomp1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && chown -R node:node /srv
COPY --from=build --chown=node:node /srv/dist ./dist
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7600 \
    SEARCH_BACKEND=meilisearch
EXPOSE 7600
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:7600/health || exit 1
CMD ["node", "dist/server.js"]
