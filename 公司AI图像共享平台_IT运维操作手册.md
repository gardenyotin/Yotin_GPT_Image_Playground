# 公司 AI 图像共享平台 IT 运维操作手册

## 2026年11月9日远程核验与维护入口

本节来自实际 SSH 和 HTTP 核查，优先于后文旧版操作说明。本轮没有更新程序、重启服务、改供应商配置或执行生图。后续发布前仍须重新核对运行状态与备份。

### 登录与部署位置

- 本机 `/home/yotin/.ssh/config` 已配置 `ssh yotin220`，目标 `yotin@192.168.0.220:22`；已用禁止密码的独立连接验证成功。
- 本机专用私钥为 `~/.ssh/id_ed25519_yotin220`，权限 600；公钥已追加到远端 `~/.ssh/authorized_keys`，保留原有密钥。公钥指纹为 `SHA256:TOabQMxjd3/Ga3zXYR9qdlsVNY7e7Gcm7HrvUSBI7us`。
- 不记录密码或私钥内容；此配置仅保证该本机可免密登录，sudo 仍沿用服务器权限规则。
- 主机名 `yotin-Macmini`，Linux Mint 22.3，Python 3.12.3。
- `http://192.168.0.220:5731/` 返回 200，标题 `GPT Image Playground`；`/api/health` 返回 `{"ok":true,"service":"ai-gallery"}`。
- 监听 `0.0.0.0:5731`，Python 进程由 systemd 管理，不是 Docker 服务；核验时 PID 3945826，启动于 2026-11-02 16:57（该 PID 不是长期配置）。
- 服务文件 `/etc/systemd/system/ai-gallery.service`；已 enabled、active/running；用户/组 `yotin:yotin`。
- 工作目录 `/opt/ai-gallery`；命令 `/usr/bin/python3 /opt/ai-gallery/server.py`；EnvironmentFile `/opt/ai-gallery/.env`。
- 前端 `/opt/ai-gallery/app`，数据 `/opt/ai-gallery/data`；systemd 限制只允许写 data，`ProtectHome=true`。未来若需读花园目录中的凭据，不能假定当前沙箱允许，应使用本服务自己的受控凭据位置。

### 供应商配置与源码差异

线上为 `AICompanyGallery/1.1`，`server.py` 1342 行、59144 字节，SHA256：

```text
596a945352228a42500956e0accebe350b6050ea0e16a658e97c302ca9884e31
```

它与本机 `/home/yotin/share/ai-gallery/server.py` 字节一致。核验时仓库 `deploy/ai_gallery_server.py` 为 1.0；下方第一阶段已在本地分支原样承接 1.1，尚未提交或发布。线上目录没有 `.git`；以后发布须按本地记录的 SHA 核对，不用旧副本覆盖。

前端 index.html SHA256 为 `d25b22fc5cc1bc05d3949b86d5930ad2865c0fe08ac1c8709348cbb617ffc740`，引用 `assets/index-Cv7Fwl-r.js` 与 `assets/index-B74eP2fC.css`。这能定位现有产物，不证明其完整源码已与 Git 对齐。

当前存在两处配置：

| 文件 | 实际用途 | 核验权限 |
| --- | --- | --- |
| `/opt/ai-gallery/.env` | 启动参数及旧单供应商回退配置 | 600 root:root |
| `/opt/ai-gallery/ai-providers.json` | 1.1 多供应商配置，按 mtime/size 热加载，schema=1 | 640 root:yotin |

JSON 当前 `active_vendor_id=intelalloc`，`failover=true`；还有山海、aicodemirror、ark-seedream。各家配置 `max_retries=2`、`timeout_seconds=300`；前三家模型 `gpt-image-2.5-sunburst`，Seedream 为 `doubao-seedream-4-0-250828`。这是配置事实，不代表各家现时可用或实际产生过调用。`/api/runtime-config` 返回 Sunburst、`streamImages=true`、`streamPartialImages=3`。

更换模型或服务商时，应先判断实际使用的 JSON 节点；后文仅修改 `.env` 的旧步骤不足以更改现行活动供应商。JSON、env 可能含密钥，不提交 Git，不放前端目录。

当前代理对部分超时、5xx、无可用响应可能重新提交/切换；这与 Garden 的“结果未知不重发”规则不同。未来接入 Garden 后，只保留一处供应商调度，不能叠加两层重试。

### 数据与备份边界

SQLite 为 `/opt/ai-gallery/data/gallery.db`，存在 WAL/SHM；只读统计为 users=20、generations=581。图片 581 个/163812288 字节、参考图 1021 个/225687984 字节、缩略图 581 个/10396478 字节，均为本次快照。

`/opt/ai-gallery/backups/` 有 8 份旧代码/配置/前端备份，包含 edits、providers、config、app、stream 前缀；本轮未发现这些备份完整覆盖当前数据库和媒体，也未发现专属图库备份 timer 或当前用户 cron。不能把旧补丁备份当作当前完整回退点。

正式发布前需要另建一致性备份：server.py、完整 app（含旧资源）、systemd 单元、env、ai-providers.json、SQLite 在线 backup 和 images/references/thumbnails；核对恢复方法后再切换。数据库有 WAL 时，不单独复制 gallery.db 冒充一致性备份。尚未执行本轮发布备份或恢复演练。

只读维护命令：

```bash
ssh yotin220
systemctl --no-pager status ai-gallery.service
systemctl --no-pager cat ai-gallery.service
ss -ltnp '( sport = :5731 )'
curl -fsS http://127.0.0.1:5731/api/health
curl -fsS http://127.0.0.1:5731/api/runtime-config
journalctl -u ai-gallery.service --since today --no-pager
```

日志可能含提示词或供应商返回内容，外发前脱敏。后续部署/重启仍需当轮明确授权。

### 第一阶段：承接线上 1.1 本地基线（2026-11-09）

本阶段只处理部署源码缺失，不升级上游前端、不接入 Garden、不更改 220 服务或真实数据。分支为 `chore/capture-live-baseline-20261109`，从 `main@bf8e8217e73a43ebd37b11655b3d65a01dcb3848` 创建；原有本手册的远程核验记录保留，变更尚未提交或推送。

- 再次通过 `ssh -o BatchMode=yes yotin220 'sha256sum /opt/ai-gallery/server.py'` 核对本机 share 副本与线上一致，然后原样复制到 `deploy/ai_gallery_server.py`。三者 SHA256 均为上方 `596a9453…884e31`；承接文件为 1342 行、59144 字节，未格式化或修改业务行为。
- 静态 AST 字符串扫描：完整 `sk-` 样式 Key、字面 Bearer token、PEM/OpenSSH 私钥各 0 项；没有复制线上 env 或供应商 JSON。该检查不是对所有可能凭据格式的完整审计。
- `deploy/test_stream_proxy.py` 已适配 1.1 的供应商配置、入站解析和成品归一接口，移除对已删除 `replace_multipart_field` 的调用。所有测试使用临时配置和临时 SQLite/媒体目录；import 前隔离 `AI_GALLERY_*`，供应商为假 loopback HTTP 服务，重试设为 0、failover 关闭。URL 白名单及 socket connect/connect_ex 阻断非 loopback 出站，并有拒绝外网的反例断言；不请求真实供应商。
- 本机运行 `python3 -m unittest discover -s deploy -p 'test_stream_proxy.py' -v`：8 项通过，含单/双图在 relay JSON 与 multipart 两种出站协议下的顺序保持、health/runtime、JSON/SSE 成品与结束前心跳、Responses 成品归一、401/非法输入、外网阻断，以及旧行和媒体的初始化保留。日志为 `/tmp/playground-baseline-python-20261109.log`；这些是假上游协议 smoke，不是实际出图或完整浏览器验收。
- 承接前后 `init_storage` AST 相同：本阶段没有 SQLite schema 变更。临时库中预置用户/作品后再次初始化，逐字段及媒体字节保持不变。真实 SQLite、images/references/thumbnails、浏览器历史数据全部保留；不能因为上游没有公司数据库而删除。没有连接或初始化生产数据库，也没有清理任何真实数据。
- 1.1 现有的结果未知重试/切换风险原样保留；通过基线测试不代表认可该策略。后续接统一 AI 服务时应移除 Playground 供应商重试/切换，只由 AI 服务管理生成尝试。

下一阶段才升级固定上游版本并迁回公司身份、图库和受管配置；发布前另做完整数据备份与恢复验证，不把源码承接当作上线或数据迁移授权。

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
| 当前模型配置 | 优先核对 `/opt/ai-gallery/ai-providers.json` 活动节点，`.env` 为旧回退配置 |
| 当前模型（2026-11-09 核验） | `gpt-image-2.5-sunburst`（以后以服务器配置为准） |

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

真实上游地址、API Key 和模型 ID 保存在以下服务端配置中：

```text
/opt/ai-gallery/.env
/opt/ai-gallery/ai-providers.json
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
