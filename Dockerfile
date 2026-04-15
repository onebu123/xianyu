FROM node:22-bookworm-slim AS builder

WORKDIR /app

ARG VITE_APP_BASE_PATH=/
ARG VITE_API_BASE_URL=

COPY package*.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

RUN npm install

COPY . .

ENV VITE_APP_BASE_PATH=$VITE_APP_BASE_PATH
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV APP_RUNTIME_MODE=prod
ENV HOST=0.0.0.0
ENV PORT=4300
ENV APP_DATA_ROOT=/app/server/data
ENV APP_DB_PATH=/app/server/data/app.db
ENV APP_LOG_ROOT=/app/server/data/logs
ENV APP_BACKUP_ROOT=/app/server/data/backups
ENV APP_UPLOAD_ROOT=/app/server/data/uploads
ENV APP_ENABLE_DEMO_DATA=false

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server/package.json server/package.json
COPY --from=builder /app/web/package.json web/package.json
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/server/dist server/dist
COPY --from=builder /app/web/dist web/dist

RUN mkdir -p /app/server/data /app/server/data/logs /app/server/data/backups /app/server/data/uploads

EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4300/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "-w", "server"]
