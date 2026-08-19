FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    DEPLOYMENT_TARGET=container \
    RUNTIME_MODE=mock \
    MODEL_BACKEND=fake \
    GOOGLE_GEMINI_ENABLED=false \
    PORT=8080 \
    DATA_PATH=/data/runs.json

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY web ./web
COPY schemas ./schemas
COPY README.md ./README.md
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
