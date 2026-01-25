FROM node:20-bookworm-slim AS build

WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/tsconfig.json client/tsconfig.node.json client/vite.config.ts client/index.html ./
COPY client/src ./src
RUN npm run build


FROM nginx:1.27-alpine AS runtime

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
