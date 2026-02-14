# Open Claude Cowork — backend + web UI for Coolify
FROM node:20-alpine

WORKDIR /app

# Server
COPY server/package.json server/package-lock.json ./server/
COPY server/ ./server/

# Web UI (served by Express)
COPY renderer/ ./renderer/

RUN cd server && npm ci --omit=dev

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
