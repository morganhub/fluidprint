# Fluidprint en ligne : serveur Node (API, app construite, Vite pour la route d'impression lue par l'export),
# Chromium (mesure, rendu, PDF) et Python (pikepdf, Pillow : post-traitement PDF/X-4 CMJN).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium python3 python3-venv fonts-liberation fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    FLUIDPRINT_HOST=0.0.0.0 \
    FLUIDPRINT_DOCUMENTS_DIR=/data/documents \
    PORT=5190

WORKDIR /app
RUN mkdir -p /data/documents && chown node:node /app /data /data/documents
USER node

# Dépendances de développement comprises : l'export lance un serveur Vite (route d'impression) et tsx.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node print/requirements.txt print/requirements.txt
COPY --chown=node:node scripts/setup-print.mjs scripts/setup-print.mjs
RUN node scripts/setup-print.mjs

COPY --chown=node:node . .
RUN npm run build

EXPOSE 5190
CMD ["node", "--import", "tsx", "server/index.ts"]
