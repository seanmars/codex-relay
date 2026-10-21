# codex-relay

讓 Claude Code 的每個視窗各自選擇走 **Claude** 或 **OpenAI Codex**. Codex 使用 Codex CLI 的 ChatGPT 登入, statusline 會顯示這個 session 的 Codex model, token 用量和方案剩餘額度.

```text
Claude Code ── ANTHROPIC_BASE_URL ──▶ relay (Node, 127.0.0.1:8960)
                                        ├─ session = claude ─▶ api.anthropic.com (原封不動轉送)
                                        └─ session = codex  ─▶ claude-code-proxy (Rust, 127.0.0.1:8970)
                                                                 └─▶ chatgpt.com/backend-api/codex
```

- `relay/`: Node relay. 負責 per-session 路由, sticky 狀態, `/__health`, 並自動啟動 proxy.
- `proxy/`: 精簡版 [claude-code-proxy](https://github.com/seanmars/claude-code-proxy). 只保留 Codex, 預設使用 Codex CLI 登入.
- `hooks/`: Claude Code plugin. 提供 `/relay` 指令, 面板, statusline 和 `codex-relay:codex` subagent.

## 需求

- Node.js 20 以上
- Rust toolchain (用來安裝 proxy)
- Codex CLI, 並已執行 `codex login` (ChatGPT 帳號)
- Claude Code, 支援 plugin hooks module 的版本 (在 2.1.306 測試)

## 安裝

1. 安裝 proxy:

   ```sh
   cargo install --path proxy
   ```

   Binary 名稱是 `claude-code-proxy`. 如果已經安裝上游版本, 這個指令會取代它.

2. 安裝 plugin:

   ```sh
   claude plugin marketplace add <這個 repo 的路徑或 GitHub owner/repo>
   claude plugin install codex-relay@codex-relay
   ```

3. 開啟新的 Claude Code session, 執行 `/relay status` 確認狀態.

Plugin 會在 session 開始時啟動 relay, 並只對**這個 session** 設定 `ANTHROPIC_BASE_URL`. 它不會修改 `settings.json`. Relay 沒有回應時, session 會回到原本的位址.

## 使用

| 指令 | 說明 |
|---|---|
| `/relay` | 開啟面板 (`ctrl+x tab` 後按按鈕上的鍵) |
| `/relay codex` · `/relay claude` | 切換這個視窗. 只影響目前的 session |
| `/relay default [codex\|claude]` | 查看或設定新 session 的預設路由 |
| `/relay status` | 顯示路由, relay, proxy 與 Codex 用量 |
| `/relay usage` | 顯示 Codex 方案的用量上限 |
| `/relay models [--full]` | 列出帳號目前可用的 Codex model, 以及 proxy 是否支援. `--full` 也列出 hidden model |
| `/relay auth [status\|login\|device\|logout]` | Codex CLI 登入. `login` 會開啟瀏覽器 |
| `/relay monitor` | 顯示開啟 monitor TUI 的指令 (需要另一個終端機) |
| `/relay start` · `stop` · `restart` | 控制 relay. 加上 `--proxy` 會一併停止 proxy |

**預設路由的規則**: session 送出第一個 request 時會固定使用當下的預設路由. 之後修改預設, 只會影響新的 session, 進行中的對話不會換路徑, 也不會重建 prompt cache.

**Subagent**: `codex-relay:codex` agent type 會在 Codex 上執行 (model 由 `agentModel` 指定). 主對話可以留在 Claude.

**Statusline 範例**: `Codex gpt-5.6-terra · 12.3k in / 678 out · 5h 23% · 週 41%`

## 設定

設定檔是 `~/.claude/codex-relay.json` (有設定 `CLAUDE_CONFIG_DIR` 時放在該目錄). 檔案不存在時使用預設值.

| 欄位 | 預設值 | 說明 |
|---|---|---|
| `port` | `8960` | Relay 的 port |
| `proxyPort` | `8970` | Proxy 的 port. Relay 會用 `--port` 啟動 proxy |
| `proxyCommand` | `"claude-code-proxy"` | Proxy 執行檔名稱或完整路徑 |
| `defaultRoute` | `"claude"` | 新 session 的路由: `"claude"` 或 `"codex"` |
| `agentModel` | `"gpt-5.6-terra"` | `codex-relay:codex` subagent 使用的 Codex model |
| `claudeUrl` | `"https://api.anthropic.com"` | Claude 路由的上游位址 |
| `nodePath` | `"node"` | Plugin 啟動 relay 時使用的 Node 執行檔 |

Codex 端的設定 (model 對應, reasoning effort, transport 等) 在 proxy 的 `config.json`. 請參考 claude-code-proxy 文件.

Relay 也可以直接操作: `node relay/cli.mjs start | stop [--proxy] | restart [--proxy] | status [--json] | default [claude|codex]`.

## 檔案

- `~/.claude/codex-relay.json`: 設定
- `~/.claude/codex-relay-state.json`: 每個 session 的路由 (保留 7 天)
- `~/.claude/codex-relay.log`: relay log (超過 5 MB 會清空)

## 注意事項

- **Codex 路由不會送出 Claude 的認證**: relay 轉給 proxy 前會移除 `authorization` 和 `x-api-key`.
- **和 model-relay 並用**: 兩者都會設定 `ANTHROPIC_BASE_URL`, 這個 plugin 啟用後, session 會改走 codex-relay. 如果要讓 Claude 路由繼續經過 model-relay, 把 `claudeUrl` 設為 model-relay 的位址.
- **只轉譯 model call**: Codex 路由只處理 `POST /v1/messages` 和 `/v1/messages/count_tokens`. 其他 request 一律轉給 Anthropic.

## 開發

```sh
node --test "relay/*.test.mjs"      # relay 單元與整合測試
claude plugin validate .
claude plugin test .                # hooks 測試
cd proxy && cargo test --all        # proxy 測試
```
