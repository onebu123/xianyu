# 运行模式说明

## 目标

从这一版开始，系统明确区分 `demo`、`staging`、`prod` 三种运行模式，不再允许用同一套初始化逻辑混跑演示数据和生产数据。

服务端启动时会优先读取仓库根目录 `.env`，再读取系统环境变量。

## 模式定义

### `demo`

- 用途：本地演示、UI 联调、功能展示。
- 特征：允许自动初始化演示管理员、演示订单、演示店铺、演示工作台数据。
- 默认行为：`APP_ENABLE_DEMO_DATA=true`。
- 风险边界：不得用于真实业务运营。

### `staging`

- 用途：预发验证、联调验证、部署演练。
- 特征：默认不注入演示数据，但允许按需显式开启。
- 默认行为：建议 `APP_ENABLE_DEMO_DATA=false`。
- 风险边界：可用于验收，不应承载正式业务数据。

### `prod`

- 用途：正式私有化交付环境。
- 特征：禁止自动注入演示订单、演示商品、演示店铺。
- 默认行为：必须关闭演示数据，并提供初始化管理员。
- 风险边界：任何演示播种逻辑进入该模式都视为缺陷。

## 关键环境变量

### 基础变量

- `APP_RUNTIME_MODE`：运行模式，可选 `demo`、`staging`、`prod`。
- `HOST`：监听地址。
- `PORT`：监听端口。
- `JWT_SECRET`：鉴权密钥。

### 存储路径

- `APP_DATA_ROOT`：运行数据根目录。
- `APP_DB_PATH`：数据库文件路径。
- `APP_LOG_ROOT`：日志目录。
- `APP_BACKUP_ROOT`：备份目录。
- `APP_UPLOAD_ROOT`：上传目录。

### 初始化相关

- `APP_ENABLE_DEMO_DATA`：是否注入演示数据。
- `APP_INIT_ADMIN_USERNAME`：首次初始化管理员账号。
- `APP_INIT_ADMIN_PASSWORD`：首次初始化管理员密码。
- `APP_INIT_ADMIN_DISPLAY_NAME`：首次初始化管理员显示名。

## 推荐配置

### 本地演示

```bash
APP_RUNTIME_MODE=demo
APP_ENABLE_DEMO_DATA=true
APP_INIT_ADMIN_USERNAME=admin
APP_INIT_ADMIN_PASSWORD=replace-with-a-demo-admin-password
APP_INIT_ADMIN_DISPLAY_NAME=系统管理员
APP_DATA_ROOT=./server/data
APP_DB_PATH=./server/data/app.db
APP_LOG_ROOT=./server/data/logs
APP_BACKUP_ROOT=./server/data/backups
APP_UPLOAD_ROOT=./server/data/uploads
```

### 生产部署

```bash
APP_RUNTIME_MODE=prod
APP_ENABLE_DEMO_DATA=false
APP_INIT_ADMIN_USERNAME=owner
APP_INIT_ADMIN_PASSWORD=replace-with-a-strong-password
APP_INIT_ADMIN_DISPLAY_NAME=系统管理员
APP_DATA_ROOT=/app/server/data
APP_DB_PATH=/app/server/data/app.db
APP_LOG_ROOT=/app/server/data/logs
APP_BACKUP_ROOT=/app/server/data/backups
APP_UPLOAD_ROOT=/app/server/data/uploads
```

## 初始化规则

### 空库 + `demo`

- 自动创建演示管理员。
- 自动注入演示订单、店铺、商品、工作台数据。

### 空库 + `prod`

- 只允许创建初始化管理员。
- 不允许自动注入演示订单、演示商品、演示店铺。

### 非空库 + `prod`

- 不追加演示数据。
- 不覆盖现有管理员。

## 完成判定

- `prod` 模式空库初始化后，`users` 表允许有初始化管理员。
- `prod` 模式空库初始化后，`orders`、`products`、`managed_stores` 不应被自动写入演示数据。
- `/api/health` 应返回当前 `runtimeMode`，便于验收部署环境。
- 默认无配置启动时按 `prod` 模式处理，避免误写入演示数据。
