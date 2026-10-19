# Build-Kontext ist das Repository-Wurzelverzeichnis:  docker build -f apps/api/Dockerfile .
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATABASE_PATH=/data/dokufy.sqlite FILES_PATH=/data/files PORT=8787
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/v1/health || exit 1
CMD ["node", "src/server.ts"]
