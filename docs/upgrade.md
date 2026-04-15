# 升级说明

## 适用范围

本文档用于第1轮交付范围内的私有化升级流程，适用于单机 Docker Compose 部署。

## 升级原则

- 升级前必须先备份数据库和配置。
- 升级前必须记录当前版本、容器状态和环境变量。
- 升级时不得覆盖 `server/data/` 持久化目录。
- 升级后必须验证健康检查和关键登录链路。

## 升级前检查

### 必查项

- 当前服务可正常访问。
- `docker compose ps` 状态正常。
- `.env` 文件存在且内容完整。
- `server/data/app.db` 存在。
- 可用磁盘空间充足。

### 建议记录

```bash
docker compose ps
docker compose logs --tail=100
curl http://127.0.0.1:4300/api/health
```

## 升级步骤

### 1. 备份数据和配置

```bash
cp .env .env.bak.$(date +%Y%m%d-%H%M%S)
cp server/data/app.db server/data/app.db.bak.$(date +%Y%m%d-%H%M%S)
```

如有上传文件，也应备份：

```bash
tar -czf server/data/uploads.$(date +%Y%m%d-%H%M%S).tar.gz server/data/uploads
```

### 2. 拉取或更新代码

```bash
git pull
```

如果不是用 Git 更新，则替换代码目录，但不要删除 `server/data/`。

### 3. 对照新的 `.env.example`

检查是否新增了环境变量：

```bash
git diff .env.example
```

或者手工比对：

- `APP_RUNTIME_MODE`
- `APP_ENABLE_DEMO_DATA`
- `APP_INIT_ADMIN_*`
- `VITE_APP_BASE_PATH`
- `VITE_API_BASE_URL`

### 4. 重建并启动容器

```bash
docker compose up -d --build
```

### 5. 升级后验收

```bash
docker compose ps
docker compose logs --tail=100
curl http://127.0.0.1:4300/api/health
```

## 升级验收标准

- 健康检查返回 `status: ok`
- `runtimeMode` 与预期一致
- 管理员可以正常登录
- 原有数据库仍在
- 原有上传目录仍在
- 关键页面可以打开

## 严禁操作

- 不要在 `prod` 环境执行 `npm run seed`
- 不要删除 `server/data/`
- 不要跳过 `.env` 变量比对

## 升级失败处理

如果升级后服务无法正常使用，立即执行回滚流程，见 [rollback.md](/D:/codex/goofish-sale-statistics/docs/rollback.md)。
