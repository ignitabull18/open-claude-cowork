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

# Supabase (required for auth, persistence, storage)
ENV SUPABASE_URL=""
ENV SUPABASE_ANON_KEY=""
ENV SUPABASE_SERVICE_ROLE_KEY=""

# OpenAI (optional — enables vector search embeddings)
ENV OPENAI_API_KEY=""

# Allow anonymous access during migration (set to false when done)
ENV ALLOW_ANONYMOUS="true"

EXPOSE 3001

CMD ["node", "server.js"]
