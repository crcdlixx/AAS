# Docker / docker-compose

## 1) 准备环境变量

1. 配置后端环境变量：
   - 复制 `server/.env.example` 为 `server/.env`
   - 填入 `OPENAI_API_KEY` 等必要配置

2. （可选）用于 Docker Hub 推送的镜像命名：
   - 复制 `.env.example` 为 `.env`
   - 修改 `DOCKERHUB_USERNAME` 为你的 Docker Hub 命名空间（Docker ID / 组织名，不能是邮箱）
   - 例：`mine1craft2`（而不是 `mine1craft2@126.com`）

## 2) 本地构建 & 运行

```bash
docker compose build
docker compose up -d
```

访问：`http://localhost:8080`（端口可通过 `.env` 里的 `WEB_PORT` 修改）

查看日志：

```bash
docker compose logs -f --tail=200
```

## 3) 推送到 Docker Hub

```bash
docker login
docker compose push
```

推送的镜像：
- `${DOCKERHUB_USERNAME}/aas-web:${IMAGE_TAG}`
- `${DOCKERHUB_USERNAME}/aas-api:${IMAGE_TAG}`
- `${DOCKERHUB_USERNAME}/aas-mcp:${IMAGE_TAG}`

## 4) 生产环境（HTTPS）

推荐用 `docker-compose.prod.yml` + Caddy 自动申请/续期 Let's Encrypt 证书。

### 前置条件

- 你有一个域名（例如 `aas.example.com`）
- 域名 `A/AAAA` 记录指向部署机器公网 IP
- 服务器放行/开放端口 `80` 与 `443`

### 配置

1. 配置后端环境变量：`server/.env`（同上）
2. 配置根目录 `.env`（用于 prod compose）：
   - `DOMAIN=aas.example.com`
   - `HTTP_PORT=80`
   - `HTTPS_PORT=443`
   - （可选）如需指定 ACME 邮箱：编辑 `Caddyfile`，加上全局块 `{ email you@example.com }`

### 启动（拉取 Docker Hub 镜像）

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

访问：`https://你的域名/`

查看 Caddy 证书/路由日志：

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=200 caddy
```
