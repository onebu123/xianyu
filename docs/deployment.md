# 部署说明

## 适用范围

本文档用于第1轮交付范围内的私有化部署说明，目标是让系统能够：

- 独立安装
- 独立初始化
- 独立启动
- 区分 `demo`、`staging`、`prod`
- 保留数据库、日志、备份和上传目录

## 部署前提

### 必备环境

- Node.js 22
- npm 10 或兼容版本
- Docker 和 Docker Compose

### 目录约定

系统运行时使用以下目录：

- 数据目录：`APP_DATA_ROOT`
- 数据库文件：`APP_DB_PATH`
- 日志目录：`APP_LOG_ROOT`
- 备份目录：`APP_BACKUP_ROOT`
- 上传目录：`APP_UPLOAD_ROOT`

默认 Docker 运行目录映射为：

- 宿主机：`./server/data`
- 容器内：`/app/server/data`

## 运行模式

请先阅读 [runtime-modes.md](/D:/codex/goofish-sale-statistics/docs/runtime-modes.md)。

部署时必须明确当前模式：

- `demo`：演示环境，会初始化演示数据
- `staging`：预发环境，默认不初始化演示数据
- `prod`：生产环境，禁止自动注入演示数据

## 环境变量

### 后端运行变量

- `APP_RUNTIME_MODE`
- `HOST`
- `PORT`
- `JWT_SECRET`
- `APP_CONFIG_CIPHER_SECRET`
- `APP_LOG_LEVEL`
- `APP_REQUEST_LOGGING_ENABLED`
- `APP_METRICS_ENABLED`
- `APP_METRICS_TOKEN`
- `APP_TRUST_PROXY`
- `APP_LOGIN_MAX_ATTEMPTS`
- `APP_LOGIN_WINDOW_MINUTES`
- `APP_PRIVILEGED_WRITE_LIMIT`
- `APP_PRIVILEGED_WRITE_WINDOW_MINUTES`
- `APP_DATA_ROOT`
- `APP_DB_PATH`
- `APP_LOG_ROOT`
- `APP_BACKUP_ROOT`
- `APP_UPLOAD_ROOT`
- `APP_ENABLE_DEMO_DATA`
- `APP_INIT_ADMIN_USERNAME`
- `APP_INIT_ADMIN_PASSWORD`
- `APP_INIT_ADMIN_DISPLAY_NAME`

### 前端构建变量

- `VITE_APP_BASE_PATH`
- `VITE_API_BASE_URL`

说明：

- 前端变量带 `VITE_` 前缀，是 Vite 构建要求，不作为运行时动态变量使用。
- 后端变量统一使用 `APP_*` 前缀，表示部署和运行时参数。
- 推荐按模板文件维护：`.env.development`、`.env.staging`、`.env.production`。

## 推荐配置

### 本地演示环境

```bash
APP_RUNTIME_MODE=demo
HOST=0.0.0.0
PORT=4300
JWT_SECRET=replace-with-a-random-demo-secret
APP_CONFIG_CIPHER_SECRET=replace-with-a-second-demo-secret
APP_LOGIN_MAX_ATTEMPTS=10
APP_LOGIN_WINDOW_MINUTES=10
APP_PRIVILEGED_WRITE_LIMIT=60
APP_PRIVILEGED_WRITE_WINDOW_MINUTES=10
APP_DATA_ROOT=./server/data
APP_DB_PATH=./server/data/app.db
APP_LOG_ROOT=./server/data/logs
APP_BACKUP_ROOT=./server/data/backups
APP_UPLOAD_ROOT=./server/data/uploads
APP_ENABLE_DEMO_DATA=true
APP_INIT_ADMIN_USERNAME=admin
APP_INIT_ADMIN_PASSWORD=replace-with-a-demo-admin-password
APP_INIT_ADMIN_DISPLAY_NAME=系统管理员
VITE_APP_BASE_PATH=/
VITE_API_BASE_URL=
```

### 生产环境

```bash
APP_RUNTIME_MODE=prod
HOST=0.0.0.0
PORT=4300
JWT_SECRET=replace-with-a-random-production-secret
APP_CONFIG_CIPHER_SECRET=replace-with-a-second-production-secret
APP_LOG_LEVEL=info
APP_REQUEST_LOGGING_ENABLED=true
APP_METRICS_ENABLED=true
APP_METRICS_TOKEN=replace-with-a-production-metrics-token
APP_TRUST_PROXY=true
APP_LOGIN_MAX_ATTEMPTS=10
APP_LOGIN_WINDOW_MINUTES=10
APP_PRIVILEGED_WRITE_LIMIT=60
APP_PRIVILEGED_WRITE_WINDOW_MINUTES=10
APP_DATA_ROOT=./server/data
APP_DB_PATH=./server/data/app.db
APP_LOG_ROOT=./server/data/logs
APP_BACKUP_ROOT=./server/data/backups
APP_UPLOAD_ROOT=./server/data/uploads
APP_ENABLE_DEMO_DATA=false
APP_INIT_ADMIN_USERNAME=owner
APP_INIT_ADMIN_PASSWORD=replace-with-a-strong-password
APP_INIT_ADMIN_DISPLAY_NAME=系统管理员
VITE_APP_BASE_PATH=/
VITE_API_BASE_URL=
```

### 子路径部署环境

如果通过 Nginx 子路径代理部署，例如 `/sale-compass/`，推荐：

```bash
APP_RUNTIME_MODE=prod
APP_ENABLE_DEMO_DATA=false
VITE_APP_BASE_PATH=/sale-compass/
VITE_API_BASE_URL=/sale-compass/api
```

## 本地开发

```bash
cp .env.example .env
npm install
npm run dev
```

默认地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:4300`

## 本地生产构建

```bash
npm run build
npm run preflight
npm run start
```

上线前建议追加：

```bash
npm run db:doctor
npm run smoke:release
```

默认访问地址：

- `http://127.0.0.1:4300`

## Docker Compose 私有部署

### 1. 复制环境变量模板

```bash
cp .env.example .env
```

### 2. 修改生产环境最少必改项

至少修改以下变量：

- `APP_RUNTIME_MODE=prod`
- `APP_ENABLE_DEMO_DATA=false`
- `JWT_SECRET`
- `APP_CONFIG_CIPHER_SECRET`
- `APP_INIT_ADMIN_USERNAME`
- `APP_INIT_ADMIN_PASSWORD`

### 3. 启动服务

```bash
docker compose up -d --build
```

### 4. 检查服务状态

```bash
docker compose ps
docker compose logs --tail=100
curl http://127.0.0.1:4300/api/health
```

健康检查返回中应包含：

- `status: ok`
- `runtimeMode: prod` 或预期模式
- `version`
- `configuration.envProfile`
- `configuration.strictMode: true`
- `configuration.demoDataEnabled: false`
- `configuration.bootstrapAdminConfigured: true`

如已启用指标令牌，可追加验证：

```bash
curl -H "x-metrics-token: <APP_METRICS_TOKEN>" http://127.0.0.1:4300/api/metrics
```

### 5. 验证持久化目录

启动后应至少看到：

- `server/data/app.db`
- `server/data/logs/`
- `server/data/backups/`
- `server/data/uploads/`

## Ubuntu VPS 部署

### 1. 安装 Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
docker --version
docker compose version
```

### 2. 准备部署目录

```bash
sudo mkdir -p /opt/sale-compass
sudo chown -R $USER:$USER /opt/sale-compass
cd /opt/sale-compass
```

### 3. 准备配置

```bash
cp .env.example .env
```

然后修改：

- `APP_RUNTIME_MODE=prod`
- `APP_ENABLE_DEMO_DATA=false`
- `JWT_SECRET`
- `APP_INIT_ADMIN_USERNAME`
- `APP_INIT_ADMIN_PASSWORD`

### 4. 启动服务

```bash
docker compose up -d --build
```

### 5. 放通端口

如果使用公网直连：

```bash
sudo ufw allow 4300/tcp
sudo ufw status
```

云服务器安全组也需要放通 `4300/tcp`。

## 子路径部署

如果需要通过已有 Nginx 走子路径，例如：

- `http://<VPS_IP>/sale-compass/`

则需要：

1. 构建时设置：

```bash
VITE_APP_BASE_PATH=/sale-compass/
VITE_API_BASE_URL=/sale-compass/api
```

2. 使用 [docker-compose.vps.yml](/D:/codex/goofish-sale-statistics/docker-compose.vps.yml) 覆盖构建参数。

3. 配置 Nginx 代理，可参考 [nginx.sale-compass.conf](/D:/codex/goofish-sale-statistics/deploy/nginx.sale-compass.conf)。

## 初始化说明

### `demo`

- 首次启动会自动创建演示管理员和演示数据。

### `prod`

- 首次启动只会创建初始化管理员。
- 不会自动创建演示订单、演示商品、演示店铺。

## 验收命令

```bash
npm run test -w server
npm run build -w server
npm run build -w web
```

## 故障排查

### 健康检查不通过

- 检查 `.env` 是否缺少 `JWT_SECRET`
- 检查 `.env` 是否缺少 `APP_CONFIG_CIPHER_SECRET`
- 检查端口是否被占用
- 检查 `server/data/` 是否可写

### 生产环境出现演示数据

- 检查 `APP_RUNTIME_MODE` 是否误设为 `demo`
- 检查 `APP_ENABLE_DEMO_DATA` 是否误设为 `true`
- 检查是否误执行了 `npm run seed`

### 子路径页面资源 404

- 检查 `VITE_APP_BASE_PATH`
- 检查 `VITE_API_BASE_URL`
- 检查 Nginx 子路径代理配置

## 相关文档

- [runtime-modes.md](/D:/codex/goofish-sale-statistics/docs/runtime-modes.md)
- [security-model.md](/D:/codex/goofish-sale-statistics/docs/security-model.md)
- [security-acceptance.md](/D:/codex/goofish-sale-statistics/docs/security-acceptance.md)
- [upgrade.md](/D:/codex/goofish-sale-statistics/docs/upgrade.md)
- [rollback.md](/D:/codex/goofish-sale-statistics/docs/rollback.md)
