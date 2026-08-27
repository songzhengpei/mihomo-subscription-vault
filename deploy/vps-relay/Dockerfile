FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node upstream-relay.mjs /app/upstream-relay.mjs

USER node
ENTRYPOINT ["node", "/app/upstream-relay.mjs"]
