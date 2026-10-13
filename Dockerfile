# netmap: build the web app, then run the server on Node's built-in SQLite (no native modules needed).

FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-slim
LABEL org.opencontainers.image.title="netmap" \
      org.opencontainers.image.source="https://github.com/YurkoWasHere/netmap" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090 \
    NETMAP_DB=/data/netmap.db
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
# The database (devices, their logins, poll history) lives in /data; mount a volume there.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/devices').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
