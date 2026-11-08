# 公司 AI 图像共享平台 IT 运维操作手册

## 1. 系统信息

| 项目 | 当前配置 |
| --- | --- |
| 服务器 | Linux Mint 22.3 |
| 局域网地址 | `http://192.168.0.220:5731` |
| SSH 用户 | `yotin` |
| systemd 服务名 | `ai-gallery.service` |
| 应用目录 | `/opt/ai-gallery` |
| 前端文件 | `/opt/ai-gallery/app` |
| 服务端程序 | `/opt/ai-gallery/server.py` |
| 服务端配置 | `/opt/ai-gallery/.env` |
| 数据目录 | `/opt/ai-gallery/data` |
| SQLite 数据库 | `/opt/ai-gallery/data/gallery.db` |
| 图片目录 | `/opt/ai-gallery/data/images` |
| 缩略图目录 | `/opt/ai-gallery/data/thumbnails` |
| 参考图目录 | `/opt/ai-gallery/data/references` |
| 当前模型配置 | `/opt/ai-gallery/.env` 中的 `AI_GALLERY_MODEL` |
| 当前模型（2026-09-04 核验） | `gpt-image-2`（以后以服务器配置为准） |

平台使用单进程 Python 服务和 SQLite 数据库，不依赖 Docker、Node.js、Nginx、Redis 或 PostgreSQL。

## 2. 安全与 API 隐藏机制

浏览器不会直接访问真实生图 API，也不会保存真实 API Key。
员工端设置弹窗不显示“API 配置”或“Agent 配置”，浏览器中残留的旧 API 配置也不会参与请求。

请求链路：

```text
员工浏览器
    ↓ 访问同源 /api-proxy/
192.168.0.220:5731
    ↓ 服务器添加 API Key 并转发
真实生图 API
```

真实上游地址、API Key 和模型 ID 只保存在：

```text
/opt/ai-gallery/.env
```

该文件权限应为 `600`，只有管理员可以读取。不要把它复制到前端目录、聊天记录、工单截图或代码仓库。

检查权限：

```bash
sudo stat -c '%a %U:%G %n' /opt/ai-gallery/.env
```

预期权限：

```text
600 root:root /opt/ai-gallery/.env
```

## 3. SSH 登录服务器

在同一局域网内打开终端：

```bash
ssh yotin@192.168.0.220
```

输入服务器登录密码。密码不要写入脚本或共享文档。

## 4. 更换 API Key

### 4.1 修改配置

登录服务器后执行：

```bash
sudo nano /opt/ai-gallery/.env
```

找到：

```text
AI_GALLERY_API_KEY=原来的Key
```

替换为：

```text
AI_GALLERY_API_KEY=新的Key
```

保存并退出：

- 按 `Ctrl+O`
- 按回车确认
- 按 `Ctrl+X`

不要在等号两边添加空格，不要给 Key 添加引号。

### 4.2 检查配置文件权限

```bash
sudo chmod 600 /opt/ai-gallery/.env
sudo chown root:root /opt/ai-gallery/.env
```

### 4.3 重启服务使新 Key 生效

```bash
sudo systemctl restart ai-gallery.service
```

### 4.4 检查服务

```bash
sudo systemctl status ai-gallery.service --no-pager
```

看到以下状态代表服务正常：

```text
Active: active (running)
```

健康检查：

```bash
curl -fsS http://127.0.0.1:5731/api/health
```

正常返回：

```json
{"ok":true,"service":"ai-gallery"}
```

更换 Key 后，应在网页中提交一次小尺寸测试任务，确认新 Key 有效。测试任务可能产生 API 费用。

## 5. 更换模型

模型由服务器统一配置，员工浏览器不能选择或覆盖模型。修改模型不需要重新构建前端。

### 5.1 修改模型 ID

```bash
sudo nano /opt/ai-gallery/.env
```

找到：

```text
AI_GALLERY_MODEL=gpt-image-2-all
```

将等号右侧替换为上游 API 实际支持的模型 ID，例如：

```text
AI_GALLERY_MODEL=新的模型ID
```

不要在等号两边添加空格。保存后执行：

```bash
sudo chmod 600 /opt/ai-gallery/.env
sudo chown root:root /opt/ai-gallery/.env
sudo systemctl restart ai-gallery.service
```

### 5.2 验证服务器已读取新模型

```bash
curl -fsS http://127.0.0.1:5731/api/runtime-config
```

以当前模型为例，正常返回：

```json
{"model":"gpt-image-2-all"}
```

该接口只返回模型 ID，不会返回上游 API 地址或 API Key。服务端会强制覆盖普通生图和参考图编辑请求中的模型字段，浏览器缓存的旧模型不会参与最终上游请求。

更换后应提交一次测试任务；若上游不支持该模型，网页会显示上游返回的错误。测试可能产生 API 费用。

## 6. 启动、停止和重启服务

### 启动服务

```bash
sudo systemctl start ai-gallery.service
```

### 停止服务

```bash
sudo systemctl stop ai-gallery.service
```

### 重启服务

```bash
sudo systemctl restart ai-gallery.service
```

### 查看运行状态

```bash
sudo systemctl status ai-gallery.service --no-pager
```

### 设置开机自动启动

```bash
sudo systemctl enable ai-gallery.service
```

### 取消开机自动启动

```bash
sudo systemctl disable ai-gallery.service
```

### 同时启用并立即启动

```bash
sudo systemctl enable --now ai-gallery.service
```

## 7. 查看日志

查看最近 100 行：

```bash
sudo journalctl -u ai-gallery.service -n 100 --no-pager
```

实时跟踪日志：

```bash
sudo journalctl -u ai-gallery.service -f
```

查看本次开机以来的日志：

```bash
sudo journalctl -u ai-gallery.service -b --no-pager
```

## 8. 检查端口与访问

检查 `5731` 是否监听：

```bash
ss -ltn | grep ':5731'
```

服务器本机检查：

```bash
curl -I http://127.0.0.1:5731/
```

局域网电脑访问：

```text
http://192.168.0.220:5731
```

若服务器本机能访问、其他电脑不能访问，检查：

- 电脑与服务器是否在同一局域网
- 服务器 IP 是否仍为 `192.168.0.220`
- 防火墙是否允许 TCP `5731`
- Wi-Fi 是否启用了客户端隔离

## 9. 修改真实上游 API 地址

只有上游服务迁移时才需要修改。

```bash
sudo nano /opt/ai-gallery/.env
```

修改：

```text
AI_GALLERY_API_URL=https://新的上游地址/v1
```

然后执行：

```bash
sudo chmod 600 /opt/ai-gallery/.env
sudo systemctl restart ai-gallery.service
```

真实地址只应出现在服务器配置文件中，不要写进前端构建参数。

## 10. 数据备份

需要备份以下内容：

```text
/opt/ai-gallery/data/gallery.db
/opt/ai-gallery/data/images
/opt/ai-gallery/data/thumbnails
/opt/ai-gallery/data/references
```

为了获得一致的 SQLite 备份，推荐先停止服务：

```bash
sudo systemctl stop ai-gallery.service
```

完成复制后重新启动：

```bash
sudo systemctl start ai-gallery.service
```

如果必须不停机备份数据库，使用 SQLite 在线备份命令，不要直接复制正在写入的数据库文件：

```bash
sqlite3 /opt/ai-gallery/data/gallery.db ".backup '/备份目录/gallery.db'"
```

图片目录可以使用 `rsync` 增量同步。

## 11. 常见故障

### 网页无法打开

```bash
sudo systemctl status ai-gallery.service --no-pager
curl -fsS http://127.0.0.1:5731/api/health
ss -ltn | grep ':5731'
```

### 生图提示 401 或无效 Key

检查 Key 是否过期、余额是否充足，然后按照“更换 API Key”章节更新并重启。

### 生图提示 502 或上游不可用

检查 DNS：

```bash
getent hosts <上游域名>
resolvectl status
```

检查 HTTPS 出口：

```bash
curl -I --max-time 15 https://<上游域名>/v1/models
```

当前静态网络连接使用的 DNS 为：

```text
223.5.5.5
119.29.29.29
```

### 生图提示模型不存在或不支持

检查服务器当前模型：

```bash
curl -fsS http://127.0.0.1:5731/api/runtime-config
```

确认该模型 ID 被当前上游 API 支持；如需修改，按照“更换模型”章节操作并重启服务。

### 磁盘空间不足

```bash
df -h /
du -sh /opt/ai-gallery/data/*
```

不要手工删除单个数据库记录对应的图片文件，以免产生数据库与文件不一致。应先备份，再制定清理方案。

### 数据库检查

```bash
sqlite3 /opt/ai-gallery/data/gallery.db "PRAGMA integrity_check;"
```

正常结果：

```text
ok
```

## 12. 流式传输与 524 排查（2026-09-04 更新）

本次部署备份位于 `/opt/ai-gallery/backups/stream-20260904-171921`，包含旧 `app`、`server.py` 和 `.env`。备份目录权限为 700，其中含敏感配置，不要复制到前端目录或公开共享。图片与数据库未改动。

在 `/opt/ai-gallery/.env` 中统一配置：

```text
AI_GALLERY_STREAM_IMAGES=true
AI_GALLERY_PARTIAL_IMAGES=1
```

`PARTIAL_IMAGES` 范围为 0～3。模型仍由 `AI_GALLERY_MODEL` 决定，本次流式修复不更换模型、Key 或 API 地址。配置修改后重启服务并刷新网页：

```bash
sudo systemctl restart ai-gallery.service
curl -fsS http://127.0.0.1:5731/api/runtime-config
```

响应包含 `model`、`streamImages`、`streamPartialImages`，不包含 API Key 或 API 地址。前端升级后，已打开网页的员工应先刷新，再提交任务。

服务器对普通 JSON 生图和 multipart 参考图编辑统一设置模型及流式参数。SSE 按完整事件即时转发（包含上游心跳），不等待整个任务完成；图片 URL 沿用同源图片代理机制。若上游忽略 stream 参数返回 JSON，仍能处理，但日志会记录 `nonstream_fallback=true`。流式能力取决于上游确实及时返回 SSE；本地修复不代表远端 Cloudflare 524 一定消失。

### 查看链路日志

```bash
sudo journalctl -u ai-gallery.service --since '30 minutes ago' -o cat --no-pager | grep '"event":"api_proxy"'
```

每个请求有服务器生成的 `request_id`，同时返回 `X-Request-ID` 响应头。发生上游 HTTP 错误时记录 `CF-Ray`（如果上游提供），不记录 Key、请求体或图片内容。

| phase | 含义 |
| --- | --- |
| start | 本地开始处理请求，记录接口、模型、stream、请求体字节数 |
| request_body_read | 本地完整收到浏览器请求体 |
| upstream_open_start | 开始向上游请求；后续等待包含连接、上传及等待响应头，不能再细分 |
| upstream_headers | 收到上游响应头，包含状态码、Content-Type、CF-Ray |
| upstream_first_chunk | 收到首个 SSE 字节块 |
| downstream_first_event | 首个完整 SSE 事件已转发至浏览器连接 |
| stream_complete | 流结束，包含块数、事件数及最大块间隔 |
| upstream_body_complete | 非流式响应读完；记录是否流式请求被回退为 JSON |
| upstream_http_error | 上游 HTTP 错误；524 在这里记录，而非本地伪造 |
| transport_error / client_disconnected | 传输异常或已检测到客户端断开 |
| end | 代理处理结束；status=200 仅代表已收到 HTTP 200，不代表一定成功出图，还应结合流错误事件与任务结果 |

`elapsed_ms` 从本地请求开始计时，可用于同一 request_id 各阶段相减。日志无法直接得出 backend 排队、模型生成、内部重试和存图耗时，需要供应商按请求 ID／CF-Ray 关联。上游可能不返回或不沿用本地请求 ID。

### 遇到 524 时

1. 记录网页任务时间、请求编号与 CF-Ray。
2. 查同一 request_id 的日志，确认是否收到 SSE，还是在响应头之前就返回 524。
3. 若上游收到 `stream=true` 却只返回 JSON，或 SSE 长时间无数据，让供应商检查缓冲、队列、存图和模型调用。
4. 不要盲目增大本地 timeout，也不要立即重复提交：524 后原任务可能仍在上游运行，重试可能重复计费。

本次保留原有 600 秒设置，不新增自动重试。前端开启 stream 后多图 n>1 会拆成并发调用；高峰时建议先单图验证，长期应由 backend 实现全局并发限制、持久化任务 ID 与状态查询。

### 临时回退流式开关

若供应商流式协议不兼容，可将 `AI_GALLERY_STREAM_IMAGES=false`，重启服务并刷新网页。此操作只关闭流式，不更改模型、密钥、历史任务或公司画廊。关闭后可能再次暴露同步长请求的 524 风险。

## 13. 日常巡检建议

每月检查一次：

```bash
systemctl is-active ai-gallery.service
systemctl is-enabled ai-gallery.service
df -h /
sudo journalctl -u ai-gallery.service -p warning -n 50 --no-pager
```

每季度执行一次备份恢复演练，确认数据库、主图、缩略图和参考图都能恢复。
