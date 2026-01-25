FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

COPY server/tsconfig.json ./server/
COPY server/src ./server/src
RUN cd server && npm run build && npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime

WORKDIR /app/server
ENV NODE_ENV=production
ENV PORT=5174

RUN mkdir -p /app/server/uploads && chown -R node:node /app/server

COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist

USER node

EXPOSE 5174
CMD ["node", "dist/index.js"]
