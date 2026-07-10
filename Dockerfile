ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY web-admin/package*.json ./web-admin/
RUN cd web-admin && if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN cd web-admin && npm run build

EXPOSE 18900
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
