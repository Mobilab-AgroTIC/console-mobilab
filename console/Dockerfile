# Service console Mobilab V3. Construit depuis la racine du dépôt (contexte « . ») :
#   docker compose build mobilab-console
FROM node:20.18.1-alpine AS construction
WORKDIR /app/console
COPY console/package.json console/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY console/tsconfig.json ./
COPY console/src ./src
COPY console/test ./test
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:20.18.1-alpine
ENV NODE_ENV=production TZ=Europe/Paris
WORKDIR /app
COPY ingest/package.json ingest/package-lock.json* ./ingest/
RUN cd ingest && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund)
COPY ingest ./ingest
COPY db ./db
COPY --from=construction /app/console/node_modules ./console/node_modules
COPY --from=construction /app/console/dist ./console/dist
COPY console/package.json ./console/
WORKDIR /app/console
ENV INGEST_DIR=/app/ingest CATALOGUE_DIR=/app/catalogue REPO_DIR=/app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
