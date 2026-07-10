ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app
COPY server.mjs ./

EXPOSE 19080
CMD ["node", "server.mjs"]
