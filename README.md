# DeepSeek Harness Docker

> DSH（DeepSeek Harness）的一键 Docker 镜像 — 内置 Caddy 反向代理、免密码认证、局域网零配置、开箱即用。
> **Base: Debian 13 (trixie) · node:24 · 内置 Python/CMake/GCC 开发工具链**

[![Docker Build & Push](https://github.com/SimonQvQ/deepseek-harness-docker/actions/workflows/docker-build.yml/badge.svg)](https://github.com/SimonQvQ/deepseek-harness-docker/actions/workflows/docker-build.yml)

---

## 快速开始（一行命令）

```bash
docker run -d --name deepseek-harness \
  -p 3080:3080 \
  -v dsh-data:/opt/dsh-home \
  ghcr.io/simonqvq/deepseek-harness:latest
```

打开 **http://localhost:3080**（或局域网 IP），在 Web UI 的 **Settings → 提供方目录** 中配置 API Key，即可开始使用。无需任何环境变量、无需填写 IP。

## 镜像仓库

| 仓库 | 地址 | 说明 |
|------|------|------|
| Docker Hub | [`simonqvq/deepseek-harness`](https://hub.docker.com/r/simonqvq/deepseek-harness) | `docker pull simonqvq/deepseek-harness:latest` |
| GHCR | [`ghcr.io/simonqvq/deepseek-harness`](https://github.com/SimonQvQ/deepseek-harness-docker/pkgs/container/deepseek-harness) | `docker pull ghcr.io/simonqvq/deepseek-harness:latest` |

> 国内镜像加速：`docker pull docker.1ms.run/simonqvq/deepseek-harness:latest`

## 镜像内容

- **系统**：Debian 13 (trixie)，Node.js 24（`node:24-trixie`）
- **反向代理**：Caddy 2（自动 WebSocket/SSE、长超时、安全响应头、100MB 上传）
- **开发工具链**（容器内可直接运行 agent 代码）：
  - `python3` + `pip` + `venv`
  - `cmake` + `build-essential`（gcc/g++/make）
  - `git`、`curl`、`jq`
  - `bash`、`vim`、`nano`、`ps`/`top`、`zip`/`unzip`

## 环境变量

| 变量 | 含义 | 默认值 |
|------|------|--------|
| `DSH_PORT` | DSH 内部监听端口（仅 127.0.0.1） | `3079` |
| `PROXY_PORT` | Caddy 反向代理对外端口 | `3080` |
| `PROXY_USERNAME` | Basic Auth 用户名（可选，不设则无认证） | — |
| `PROXY_PASSWORD` | Basic Auth 密码（可选） | — |
| `DSH_UPDATE_ON_START` | `true` 时启动前自动更新 DSH 到最新版 | `false` |
| `DSH_TELEMETRY_MODE` | 遥测模式（`ENABLED`/`DISABLED`） | `DISABLED` |

> **API Key 直接在 DSH Web UI 中配置**，无需（也不应）通过环境变量传入。

## 完整使用方式

### Docker Compose

```bash
git clone https://github.com/SimonQvQ/deepseek-harness-docker.git
cd deepseek-harness-docker
cp .env.example .env    # 按需修改
docker compose up -d
```

### 启用 Basic Auth（对外暴露时建议开启）

```bash
docker run -d --name deepseek-harness \
  -p 3080:3080 \
  -e PROXY_USERNAME=admin \
  -e PROXY_PASSWORD=你的密码 \
  -v dsh-data:/opt/dsh-home \
  ghcr.io/simonqvq/deepseek-harness:latest
```

### 局域网访问（零配置）

DSH 的敏感 API（`settings.*`、`credentials.*`）默认仅限回环访问。本镜像已通过两层机制解除限制，**局域网 HTTP 访问开箱即用**，无需填写 IP：

1. **Caddy 回环呈现** —— 反向代理将上游 `Host`/`Origin` 改写为 `127.0.0.1:${DSH_PORT}`，使所有敏感 API 放行。
2. **内部浏览器认证** —— 容器内交换 DSH 启动令牌取得签名会话，由 Caddy 转发给 DSH 并定期刷新。无需手动复制令牌，认证信息不会输出到日志。
3. **浏览器端回环对齐** —— 注入脚本将 `connection.isLoopback` 置为 `true`，设置面板（提供方目录 / API Key 配置）对远程浏览器可用。

同时内置 `crypto.randomUUID` polyfill，非 HTTPS 环境下 Web UI 也能正常工作。

### 数据持久化与备份

所有配置（API Key、Provider、会话）保存在 `/opt/dsh-home`，请务必挂载卷：

```bash
# 备份全部配置
docker exec deepseek-harness tar czf - -C /opt/dsh-home . > dsh-backup-$(date +%F).tar.gz

# 从备份恢复
docker run -d --name deepseek-harness \
  -p 3080:3080 \
  -v dsh-data:/opt/dsh-home \
  ghcr.io/simonqvq/deepseek-harness:latest
# 然后将 tar 包解压回卷目录即可
```

### 更新 DSH

```bash
# 方法一：拉取最新镜像（推荐）
docker pull ghcr.io/simonqvq/deepseek-harness:latest
docker rm -f deepseek-harness
docker run -d --name deepseek-harness -p 3080:3080 -v dsh-data:/opt/dsh-home \
  ghcr.io/simonqvq/deepseek-harness:latest

# 方法二：启动时自动更新容器内 DSH（每次启动拉取 npm 最新版）
docker run -d --name deepseek-harness \
  -p 3080:3080 \
  -e DSH_UPDATE_ON_START=true \
  -v dsh-data:/opt/dsh-home \
  ghcr.io/simonqvq/deepseek-harness:latest
```

### 进入容器调试

```bash
docker exec -it deepseek-harness bash
# Python、C++、Node 都可以直接使用：
python3 --version && cmake --version && gcc --version
```

## 工作原理

```
浏览器 ──HTTP 3080──► Caddy（Basic Auth 可选）
                         │  header_up Host/Origin → 127.0.0.1:3079（回环呈现）
                         ▼
                    DSH web (127.0.0.1:3079)
```

- DSH 仅监听 `127.0.0.1`，对外唯一入口是 Caddy，避免直接暴露 RCE 面。
- 免密码模式：`DSH_PERMISSION_MODE=danger-full-access`（审批策略 `never`）。
- 每日 00:00 UTC 由 GitHub Actions 自动构建并推送最新版到 Docker Hub + GHCR。
- 每次构建自动运行 **smoke test**：启动容器 → curl 验证页面 → 模拟局域网 Host 验证特权 API 返回 200（401 / 403 均视为失败） → 通过后才发布。
- 失败时自动上传 `dsh-error-logs` 与 `docker-build-files` 构建产物供排查。

## 常见问题

**Q: 浏览器报 `crypto.randomUUID is not a function`？**

镜像已内置 polyfill，更新到最新镜像并硬刷新浏览器（清除缓存）即可。

**Q: 报 `settings are unavailable in this browser` / 提供方目录加载失败？**

镜像已内置回环放行与浏览器端对齐，更新到最新镜像后硬刷新即可，无需任何配置。

**Q: 改端口？**

```bash
docker run -d -p 8088:3080 -e PROXY_PORT=3080 ...   # 对外 8088，容器内仍是 3080
```

**Q: 想在容器里装更多软件？**

```bash
docker exec -it deepseek-harness bash
apt update && apt install -y <包名>
```

> 容器重启后手动安装的软件会丢失；如需持久化请自行使用自定义 Dockerfile 扩展。

## 开发与构建

```bash
# 本地构建
docker build -t deepseek-harness:local .

# 从源码运行（不构建镜像，仅用本机 node）
npm install -g @deepseek-ai/dsh
dsh web --host 127.0.0.1 --port 3079 --no-open
```

## License

MIT