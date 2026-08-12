# Semantic Answer Tree 设置指南

*Explore every answer, branch by branch*

这套本地工具把每次成功发布保存为一个 immutable turn，并按稳定的 source session 组成 transcript。公共答案仍使用 `SemanticAnswer` schema v1；session、turn、request summary、idempotency 和 auth 都只存在于发布外围协议。

## 1. 安装与启动

要求：

- Node.js `>=22.13.0`；
- Codex CLI，用于注册本地 stdio MCP server；
- 如需浏览器测试，首次执行 `npx playwright install chromium`。

在项目根目录安装依赖：

```powershell
npm install
```

终端一启动本地 transcript 服务：

```powershell
npm run local
```

服务默认监听 `http://127.0.0.1:4318`。首次启动会创建 SQLite database、执行 migration，并在未配置直接 token 时创建 capability-token file。

```powershell
Invoke-RestMethod http://127.0.0.1:4318/health
```

终端二启动固定查看页：

```powershell
npm run dev
```

打开 [http://localhost:4173](http://localhost:4173)。查看页显示 session 列表和 immutable turns；新的 `turn-published` 事件只携带 IDs，页面再读取已 commit 的 turn。

## 2. Runtime 路径、token 与环境变量

从项目根目录使用默认值即可。生产性本地使用建议把 DB 和 token file 都解析为绝对路径，并让 HTTP 服务与 MCP adapter 指向同一个 token file。

| 环境变量 | 默认值 | 使用者与作用 |
| --- | --- | --- |
| `SEMANTIC_ANSWER_DB` | `.semantic-answer/semantic-transcript.sqlite3` | HTTP 服务使用的 SQLite database；MCP adapter 也用它推导默认 token-file path。 |
| `SEMANTIC_ANSWER_LEGACY_FILE` | 未设置 | HTTP 服务；仅显式设置时尝试一次性 import 指定的旧 schema-v1 文件。 |
| `SEMANTIC_ANSWER_TOKEN` | 未设置 | HTTP 服务或 MCP adapter；直接提供 capability token，优先于 token file。 |
| `SEMANTIC_ANSWER_TOKEN_FILE` | database 同目录下的 `capability-token` | HTTP 服务或 MCP adapter；共享 token。 |
| `SEMANTIC_ANSWER_SERVICE_URL` | `http://127.0.0.1:4318` | MCP adapter；不带 path/query/credentials 的 loopback HTTP origin。 |
| `SEMANTIC_ANSWER_PORT` | `4318` | HTTP 服务监听端口。 |
| `NEXT_PUBLIC_SEMANTIC_ANSWER_API` | `http://127.0.0.1:4318` | 查看页读取 session、turn 和 SSE 的 origin；启动或 build 前设置。 |
| `SEMANTIC_ANSWER_SESSION_KEY` | 未设置 | 仅 hook/wrapper 不可用时，为一个 conversation 做显式 MCP binding。 |
| `SEMANTIC_ANSWER_TURN_KEY` | 未设置 | 专用 wrapper 的可选 turn binding；每个 logical turn 必须不同，不要静态复用。 |
| `SEMANTIC_ANSWER_VIEWER_ORIGINS` | `http://localhost:4173,http://127.0.0.1:4173` | HTTP 服务允许的精确 viewer origins，以逗号分隔。 |

相对路径以启动进程的 cwd 为基准。下面的 PowerShell 只为当前终端设置环境，不写用户配置：

```powershell
$projectRoot = (Get-Location).Path
$runtimeRoot = Join-Path $projectRoot ".semantic-answer"
$env:SEMANTIC_ANSWER_DB = Join-Path $runtimeRoot "semantic-transcript.sqlite3"
$env:SEMANTIC_ANSWER_TOKEN_FILE = Join-Path $runtimeRoot "capability-token"
npm run local
```

默认启动不会读取任何 legacy 文件。只有迁移旧安装时，才在启动服务前把 `SEMANTIC_ANSWER_LEGACY_FILE` 显式设为旧 schema-v1 文件的路径；不要把真实 legacy 文件复制到 `public/`。

`SEMANTIC_ANSWER_TOKEN` trim 后必须至少 32 字符；有效 Bearer token 不能含空白。不要使用 `NEXT_PUBLIC_*` 变量传 token，也不要把 token 放进答案、request summary、日志或 Git。Token file 在支持 POSIX mode 的系统上使用 `0600`；Windows 不保证暴露 POSIX permission bits，因此仍应把 runtime 目录留在私有用户 workspace。

自定义端口时，在两个终端中保持一致：

```powershell
# HTTP 服务终端
$env:SEMANTIC_ANSWER_PORT = "4319"
npm run local
```

```powershell
# Viewer 终端
$env:NEXT_PUBLIC_SEMANTIC_ANSWER_API = "http://127.0.0.1:4319"
npm run dev
```

已注册的 MCP adapter 也必须把 `SEMANTIC_ANSWER_SERVICE_URL` 改成 `http://127.0.0.1:4319`，然后重启 Codex；第 3 节注册命令中的 `$serviceUrl` 就是这个独立设置。手动运行 adapter 时可在其终端设置：

```powershell
$env:SEMANTIC_ANSWER_SERVICE_URL = "http://127.0.0.1:4319"
npm run mcp
```

如果 viewer origin 也改变，把它加入 `SEMANTIC_ANSWER_VIEWER_ORIGINS`；该变量只接受完整、精确的 loopback HTTP(S) origin，不使用 wildcard。

## 3. 注册 thin MCP adapter

`server/mcp-server.mjs` 不直接打开 SQLite。它通过 `SEMANTIC_ANSWER_SERVICE_URL` 和 capability token 调用唯一的 HTTP 服务。

先运行一次 `npm run local`，确保默认 token file 已创建。然后在项目根目录解析绝对路径并注册：

```powershell
$nodePath = (Get-Command node).Source
$mcpPath = (Resolve-Path .\server\mcp-server.mjs).Path
$serviceUrl = "http://127.0.0.1:4318"
$tokenFile = Join-Path (Get-Location).Path ".semantic-answer\capability-token"

codex mcp add semantic-answer-viewer `
  --env "SEMANTIC_ANSWER_SERVICE_URL=$serviceUrl" `
  --env "SEMANTIC_ANSWER_TOKEN_FILE=$tokenFile" `
  -- $nodePath $mcpPath

codex mcp list
```

兼容性说明：产品已从 **Semantic Answer Viewer** 更名为 **Semantic Answer Tree**，但技术 MCP 注册名仍必须精确保留为 `semantic-answer-viewer`；hook matcher、tool names 和现有配置中的该标识均不改名。

重启 Codex，并用 `/mcp` 检查 `semantic-answer-viewer`。Codex CLI、桌面应用和 IDE extension 在同一 Codex host 上共享 MCP 配置；官方配置说明见 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

MCP 暴露三个 tools：

| Tool | 作用 |
| --- | --- |
| `publish_semantic_answer` | 验证并 append 一个 turn；成功返回 `{ ok: true, sessionId, turnId, sequence }`，不返回答案。 |
| `read_semantic_history` | 按当前 source session 读取 compact `roots` 或 `frontier` history。 |
| `read_semantic_turn` | 按 `turnId` 读取一个完整 immutable turn。 |

`read_semantic_history` 应先用小 limit 和 compact detail；只有 compact 信息不足时才调用一次 `read_semantic_turn`。不要自动读取大段 history 或多个 full turns。

Compact history 中，每个 root 节点只含 `content`、`childCount`，以及 `frontier` 模式下可选的一层 `children`；`answer.terms` 只含这些已返回节点实际引用的 definitions。它不会返回完整 tree，也不会用 term IDs 代替 definitions。

## 4. 配置 Codex session hook

普通 stdio MCP 配置记录 command、args、env 和 cwd，但官方文档没有说明它会自动把当前 Codex thread ID 转发到 tool arguments。这意味着“一个 MCP process”等同于“一个 conversation”是错误假设。

首选方案是仓库附带的 `integration/codex-session-hook.mjs`。仓库不附带或自动安装用户级 `hooks.json`；配置必须由使用者手工审阅和合并。

Hook 的 matcher 固定为：

```text
^mcp__semantic-answer-viewer__(publish_semantic_answer|read_semantic_history)$
```

它在 `PreToolUse` 中读取 Codex common `session_id`、turn-scoped `turn_id` 和 MCP `tool_input`，再通过 `updatedInput` 注入并覆盖同名 model-supplied fields：

```text
sourceSessionKey = "codex:" + session_id
sourceTurnKey    = turn_id
idempotencyKey  = SHA-256("codex:" + session_id + ":" + turn_id)
```

Hook 不读取 transcript、文件或网络，只读取 hook stdin 并散列 IDs。先取得绝对 command path，再让 PowerShell 在终端打印可合并的 JSON；下面的命令不会写用户 home：

```powershell
$nodePath = (Get-Command node).Source
$hookPath = (Resolve-Path .\integration\codex-session-hook.mjs).Path
$hookCommand = '"{0}" "{1}"' -f $nodePath, $hookPath

$hookConfig = [ordered]@{
  description = "Bind Semantic Answer Tree calls to the current Codex session and turn."
  hooks = [ordered]@{
    PreToolUse = @(
      [ordered]@{
        matcher = "^mcp__semantic-answer-viewer__(publish_semantic_answer|read_semantic_history)$"
        hooks = @(
          [ordered]@{
            type = "command"
            command = $hookCommand
            commandWindows = $hookCommand
            timeout = 5
          }
        )
      }
    )
  }
}

$hookConfig | ConvertTo-Json -Depth 10
```

把输出合并到用户级 `~/.codex/hooks.json`，或已 trust 项目的 `.codex/hooks.json`。Command 必须保留 Node 和脚本的绝对路径，因为 hook 从 session cwd 运行。MCP server 必须注册为精确名称 `semantic-answer-viewer`，否则 matcher 不会命中。

非 managed command hook 必须 review 和 trust。重启 Codex 后运行 `/hooks`，核对 source、matcher、command 和脚本内容，再 trust exact definition；hook definition 变化后必须重新 review。Project hook 还要求 trust 该项目的 `.codex` config layer。不要用 bypass trust 作为日常配置，也不要配置另一个同时改写这些 calls 的 hook。详细输入、`updatedInput` 和 trust 规则见 [Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)。

如果 hook input 缺少 `session_id` 或 `turn_id`，bundled 脚本会放行原 arguments、不自行编造 identity；之后 MCP/service 会拒绝缺失的 identity 或 idempotency，除非已经做了下面的显式 session binding，并为该 turn 显式提供一个可重用的 idempotency key。

### 其他 identity 方案

- App Server wrapper：使用返回的 `thread.id` 作为 source conversation key，使用 `turn.id` 作为 source turn key。不要把 `thread.sessionId` 当作 fork identity；persistent fork 有新的 `thread.id`，但保留 root `thread.sessionId`。见 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。
- 显式 fallback：只有 hook 和 wrapper 都不可用时，才在该 conversation 专用的 MCP 配置中设置唯一 `SEMANTIC_ANSWER_SESSION_KEY`。这是人工 binding；它不会自动跟随 thread、fork 或新 conversation。

实现也接受 `SEMANTIC_ANSWER_TURN_KEY`，但它必须随每个 logical turn 改变；不要在复用的 MCP 配置中静态设置，否则会触发 `source_turn_conflict`。普通 fallback 应直接在该 turn 的 tool arguments 中提供 source turn 与 idempotency key。

不要从 cwd、PID、browser tab 或“latest session”推导 identity。

## 5. 安装与使用 `semantic-zoom-final`

在项目根目录把 skill 安装到用户级目录：

```powershell
$userProfile = [Environment]::GetFolderPath("UserProfile")
$skillTarget = Join-Path $userProfile ".agents\skills\semantic-zoom-final"
New-Item -ItemType Directory -Force $skillTarget | Out-Null
Copy-Item .\semantic-zoom-final\* $skillTarget -Recurse -Force
```

Codex 通常自动发现 skill；如未出现，重启 Codex。位置和发现规则见 [官方 Skills 文档](https://developers.openai.com/codex/skills)。

```text
Use $semantic-zoom-final to publish the final answer to Semantic Answer Tree.
```

Skill 会：

1. 仅在需要前文时读取 compact history，并最多读取一个 full prior turn。
2. 生成一至两句 `requestSummary`，描述当前用户 request，不复述答案。
3. 生成完整 `SemanticAnswer` v1 tree；结构与 lexical zoom 规则不变。
4. 通过 hook 获得 source keys 和 deterministic idempotency key，并发布一个 logical envelope。
5. 收到 durable `{ ok: true, sessionId, turnId, sequence }` 后才输出：

```text
Rendered in Semantic Answer Tree.
```

成功时普通 final 不得重复正文、JSON、Markdown summary 或 glossary。

Validation rejection 时只根据 structured issue 修复一次，并用同一 idempotency key 重试一次。Timeout 导致 commit 状态不明时，用完全相同的 envelope 和 key 重试一次；已 commit 的 retry 返回原 ack，不追加 turn、不发第二个 event。仍无法确认 durable ack 时，不输出 rendered status，改为在当前 conversation 中给出完整普通答案。

## 6. HTTP API 与 fallback

本地 API：

| 方法与路径 | Auth | 用途 |
| --- | --- | --- |
| `GET /health` | 无 | 检查 service 是否可达；成功只返回 `{ ok: true }`。 |
| `GET /api/sessions` | 无 | 列出 viewer sessions。 |
| `GET /api/sessions/:id/turns?beforeSequence=&afterSequence=&limit=20&detail=full` | 无 | 分页读取一个 session 的 turns。 |
| `GET /api/turns/:id?detail=full` | 无 | 读取一个 immutable full turn。 |
| `GET /api/history?sourceSessionKey=&beforeSequence=&limit=&detail=roots|frontier` | Bearer | Agent 用 compact history。 |
| `POST /api/publish` | Bearer | 验证并 append 完整 publication envelope。 |
| `GET /events` | 无 | SSE；先发 `ready`，再发 `turn-published` 与 heartbeat。 |

Protected route 使用：

```http
Authorization: Bearer <token>
```

这是 single-user loopback viewer，不是 tenant isolation。服务拒绝绑定到 `127.0.0.1` 以外的 host；token 保护 publish 和 compact history，但 session 列表、full turns 与 SSE 是 viewer 所需的 unauthenticated loopback reads。任何能在本机直接发请求的进程都能读取整个 transcript；SQLite 中 request summaries 和答案是明文，append-only 不等于 encryption 或 per-session authorization。

Turn-page 的 `beforeSequence` 与 `afterSequence` 都是 exclusive cursor，不能同时提供；结果按 sequence 升序返回，limit 默认/最大为 20/100。History 的 limit 默认/最大为 10/50，`detail` 默认 `roots`；viewer turn detail 省略时默认 `full`。List、page 和 single-turn responses 分别使用 `{ sessions }`、`{ sessionId, turns, hasOlder, hasNewer, oldestSequence, latestSequence }`、`{ turn }`；history 返回 `{ session, turns, hasOlder, oldestSequence, latestSequence, detail }`。

HTTP fallback 必须用 `application/json` 提交完整 envelope，不是裸 `SemanticAnswer`。`sourceTurnKey` 可省略；其他四个字段在 resolved service envelope 中必需：

```json
{
  "sourceSessionKey": "manual:conversation-123",
  "sourceTurnKey": "turn-7",
  "requestSummary": "The user asked for a concise comparison of two solver choices.",
  "document": {
    "version": 1,
    "title": "Solver comparison",
    "root": {
      "content": "..."
    }
  },
  "idempotencyKey": "stable-key-for-this-turn"
}
```

PowerShell 示例：

```powershell
$token = (Get-Content .\.semantic-answer\capability-token -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4318/api/publish `
  -Headers $headers `
  -ContentType "application/json; charset=utf-8" `
  -InFile .\publication-envelope.json
```

成功 ack：

```json
{
  "ok": true,
  "sessionId": "...",
  "turnId": "...",
  "sequence": 7
}
```

SSE 连接先收到 `ready` 的 `{ "ok": true }`，之后 `turn-published` payload 恰好包含 `eventId`、`sessionId`、`turnId`、`sequence`，不包含答案正文。客户端可用已知 `Last-Event-ID` replay 最多 100 个后续 committed events；未知 ID 不 replay。

服务会拒绝 envelope 未知字段、过大的 HTTP body，以及异常的 session/idempotency/request-summary 长度；schema-v1 验证还限制 tree 深度、节点数、单节点 Markdown、总 document、term 数量、term ID 与 definition 大小。Validation response 只返回清理后的结构化 issues；查看页会 sanitize Markdown，展开节点或 term 不会触发模型请求。

常见 HTTP status 是：invalid query/envelope `400`、未找到 `404`、方法错误 `405`、idempotency/source-turn conflict `409`、body 过大 `413`、非 JSON media type `415`、内部错误 `500`。错误 envelope 为 `{ ok: false, error: { code, message, ... } }`，不会回显被拒绝的答案值。

## 7. Legacy import 与 migration

HTTP 服务启动时自动：

1. 打开 `SEMANTIC_ANSWER_DB`；
2. 启用 foreign keys、busy timeout、WAL 和 `synchronous=FULL`；
3. 依次应用尚未记录的 `server/migrations/NNN_name.sql`。

默认不读取 legacy 文件。仅当 `SEMANTIC_ANSWER_LEGACY_FILE` 显式设置时，服务才尝试读取该路径；文件不存在时直接跳过。有效 schema-v1 文件只读并一次性 import 到固定 imported session；绝对 source path 写入 import marker，因此同一路径不会重复导入。原文件不会移动、删除或改写。无效 legacy JSON/schema 不会污染 DB；启动继续运行，invalid 状态只保留在 service 内部的 import result 中。

详细 transaction、immutable turn 和 backup 说明见 [设计与迁移](DESIGN-MIGRATION.zh-CN.md)。

## 8. Hosted demo 与隐私

Hosted Sites deployment 必须保持 private，`.openai/hosting.json` 的 `d1`、`r2` 都是 `null`。Hosted build 只读取 synthetic `public/demo-transcript.json`；非 localhost 页面不会连接本地 API 或 SQLite。

应用代码不加载 remote images、telemetry 或 remote fonts。默认 runtime 在 ignored `.semantic-answer/`；如果覆盖 DB、legacy 或 token 路径，配置后的路径也必须保持 private、ignored，且不得复制到 `public/`。Hosted demo 与 local private data 是两条独立数据路径。

`npm run build` 会对 `dist` 执行针对已知 DB/token/path/canary 泄漏的 privacy scan；这是 targeted release gate，不是“任意私密文本绝不可能被 bundle”的证明。

## 9. 快速排查

- `401`：确认 HTTP 服务和 MCP adapter 使用同一 `SEMANTIC_ANSWER_TOKEN`，或同一个绝对 `SEMANTIC_ANSWER_TOKEN_FILE`。
- `403 origin_forbidden`：把实际 viewer origin 精确加入 `SEMANTIC_ANSWER_VIEWER_ORIGINS`。
- `missing_session_identity`：启用并 trust bundled hook；只有明确接受人工 binding 时才使用 `SEMANTIC_ANSWER_SESSION_KEY`。
- Hook 未运行：用 `/hooks` 查看 source、matcher、hash 和 trust 状态；确认 matcher 命中 `mcp__semantic-answer-viewer__...`。
- MCP 连接但 publish 失败：确认 `npm run local` 正在运行、`SEMANTIC_ANSWER_SERVICE_URL` 正确，并请求 `GET /health`。
- Timeout 后不确定是否写入：只用同一个 envelope/idempotency key 重试；不要生成新 key。
- Migration failure：服务不会继续使用半迁移 schema；修复原因后重启，不要手工改 immutable turns。
- Viewer 没有实时更新：检查 `GET /events` 和 `NEXT_PUBLIC_SEMANTIC_ANSWER_API`；已 commit 数据仍可通过 session/turn APIs 读取。
- Codex 没有 durable ack：不要输出 `Rendered in Semantic Answer Tree.`；在 conversation 中返回完整答案。
