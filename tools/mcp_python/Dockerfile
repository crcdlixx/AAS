FROM node:20-bookworm-slim AS build

WORKDIR /app/tools/mcp_python

COPY tools/mcp_python/package.json tools/mcp_python/package-lock.json ./
COPY package.json package-lock.json /app/
RUN npm ci

COPY tools/mcp_python/tsconfig.json ./
COPY tools/mcp_python/src ./src
RUN npm run build && npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime

WORKDIR /app/tools/mcp_python
ENV NODE_ENV=production
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0

COPY --from=build /app/tools/mcp_python/package.json ./package.json
COPY --from=build /app/tools/mcp_python/node_modules ./node_modules
COPY --from=build /app/tools/mcp_python/dist ./dist

EXPOSE 8080
CMD ["node", "dist/http.js"]
