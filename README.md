# Semantic Answer Tree

*Explore every answer, branch by branch*

一个本地、多 session 的语义答案 transcript。Codex 把每轮答案作为不可变 turn 追加到 SQLite；固定查看页按 session 浏览历史，并继续提供递归结构展开与行内词义解释。所有答案内容都在发布时一次性生成，点击展开不会请求模型。

> **Compatibility:** Semantic Answer Viewer has been renamed to **Semantic Answer Tree**, but the technical MCP registration remains exactly `semantic-answer-viewer`. Keep that identifier unchanged in Codex configuration, hook matchers, tool names, and existing integrations.

## 快速开始

要求 Node.js `>=22.13.0`。

```powershell
npm install
npm run local
```

在另一个 PowerShell 终端启动查看页：

```powershell
npm run dev
```

打开 [http://localhost:4173](http://localhost:4173)。本地服务默认监听 `http://127.0.0.1:4318`，数据库默认位于 `.semantic-answer/semantic-transcript.sqlite3`，capability token 默认保存在 `.semantic-answer/capability-token`。

继续阅读：

- [中文设置指南](docs/SETUP.zh-CN.md)：MCP、Codex session hook、token、环境变量、API 与故障处理。
- [设计与迁移](docs/DESIGN-MIGRATION.zh-CN.md)：SQLite append-only 模型、WAL、migration、legacy import 与 hosted demo 边界。
- [semantic-zoom-final skill](semantic-zoom-final/SKILL.md)：单一答案面、历史读取、可靠发布与失败 fallback。

## 常用命令

- `npm run local`：启动唯一拥有 SQLite、验证、migration 和 SSE 的本地 HTTP 服务。
- `npm run dev`：在 `http://localhost:4173` 启动固定查看页。
- `npm run mcp`：手动调试 thin stdio MCP-to-HTTP adapter；正常使用时由 Codex 启动。
- `npm test`：运行测试；首次运行浏览器测试前先执行 `npx playwright install chromium`。
- `npm run build`：构建只含 synthetic fixture 的 hosted demo。

Hosted Sites deployment 必须保持 private，且 `.openai/hosting.json` 中 `d1`、`r2` 均为 `null`。本地 SQLite、token 和真实 transcript 不会部署；应用代码不加载 remote images、telemetry 或 remote fonts。
