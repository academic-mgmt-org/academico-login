ARG NODE_VERSION=22.18.0

FROM node:${NODE_VERSION}-slim AS base

WORKDIR /usr/src/app

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder

ENV NODE_ENV=development

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --legacy-peer-deps --no-audit --no-fund --no-update-notifier; \
    else \
      npm install --legacy-peer-deps --no-audit --no-fund --no-update-notifier; \
    fi

COPY . .

RUN if node -e "process.exit(require('./package.json').scripts && require('./package.json').scripts.build ? 0 : 1)"; then \
      npm run build; \
    else \
      mkdir -p dist && cp -a src dist/src; \
    fi

RUN mkdir -p /tmp/runtime \
    && if [ -d dist ]; then cp -a dist /tmp/runtime/dist; fi \
    && if [ -f schema.bin ]; then cp schema.bin /tmp/runtime/schema.bin; fi \
    && if [ -d proto ]; then cp -a proto /tmp/runtime/proto; fi

FROM base AS production

ENV NODE_ENV=production

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund --no-update-notifier; \
    else \
      npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --no-update-notifier; \
    fi \
    && npm cache clean --force

COPY --from=builder /tmp/runtime/ ./

EXPOSE 3001

CMD ["sh", "-c", "if [ -f dist/main.js ]; then exec node dist/main.js; elif [ -f dist/src/main.js ]; then exec node dist/src/main.js; elif [ -f src/main.js ]; then exec node src/main.js; else echo 'No application entrypoint found in dist/main.js, dist/src/main.js, or src/main.js.' >&2; exit 1; fi"]
