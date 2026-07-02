#--------------------------------------- Fase de construcción-----------------------------
FROM node:22.13.0-slim AS builder

WORKDIR /usr/src/app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

#------------------------------------------ Fase de producción-----------------------------
FROM node:22.13.0-slim AS production

WORKDIR /usr/src/app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=builder /usr/src/app/dist ./dist
COPY package*.json ./

ENV NODE_ENV=production

RUN npm ci --omit=dev && rm -rf /root/.npm

EXPOSE 3001

CMD ["node", "dist/main"]
