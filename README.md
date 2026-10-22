# codex-relay

讓 Claude Code 的每個視窗各自選擇走 **Claude** 或 **OpenAI Codex**. Codex 使用 Codex CLI 的 ChatGPT 登入. Statusline 顯示這個 session 的 Codex model, context 使用率和方案用量.

```text
Claude Code ── ANTHROPIC_BASE_URL ──▶ relay (Node, 127.0.0.1:8960)
                                        ├─ session = claude ─▶ api.anthropic.com (原封不動轉送)
                                        └─ session = codex  ─▶ claude-code-proxy (Rust, 127.0.0.1:8970)
                                                                 └─▶ chatgpt.com/backend-api/codex
```

- `relay/`: Node relay. 負責 per-session 路由, sticky 狀態和 `/__health`. 需要 Codex 時自動啟動 proxy.
- `proxy/`: 精簡版 [claude-code-proxy](https://github.com/seanmars/claude-code-proxy). 只保留 Codex, 預設使用 Codex CLI 的登入.
- `hooks/`: Claude Code plugin. 提供 `/relay` 指令, 面板, statusline 和 `codex-relay:codex` subagent.

## 需求

- Node.js 20 以上
- Rust toolchain (用來編譯 proxy)
- Codex CLI, 並已執行 `codex login` (ChatGPT 帳號)
- Claude Code, 支援 plugin hooks module 的版本 (在 2.1.306 測試)

## 安裝

安裝腳本, 驗證步驟和疑難排解請看 [docs/install.html](docs/install.html). 用瀏覽器開啟這個檔案.

可以用安裝腳本完成下面的步驟. 腳本只安裝缺少的工具, 每個指令執行前都會詢問.

Windows, 在 PowerShell 7 (`pwsh`) 中執行:

```powershell
irm https://raw.githubusercontent.com/seanmars/codex-relay/main/scripts/install.ps1 | iex
```

macOS / Linux, 在終端機中執行:

```sh
curl -fsSL https://raw.githubusercontent.com/seanmars/codex-relay/main/scripts/install.sh | bash
```

手動安裝:

1. 安裝 proxy:

   ```sh
   git clone https://github.com/seanmars/codex-relay.git
   cd codex-relay
   cargo install --path proxy
   ```

   Binary 名稱是 `claude-code-proxy`. 如果已經安裝上游版本, 這個指令會取代它.

   Windows 無法取代執行中的 exe. 更新前先執行 `claude-code-proxy stop`, 或在 Claude Code 執行 `/relay stop-proxy`.

2. 安裝 plugin:

   ```sh
   claude plugin marketplace add seanmars/codex-relay
   claude plugin install codex-relay@codex-relay
   ```

3. 開啟新的 Claude Code session, 執行 `/relay status` 確認狀態.

## 使用

| 指令 | 說明 |
|---|---|
| `/relay` | 開啟面板 (`ctrl+x tab` 後按按鈕上的鍵) |
| `/relay codex` · `/relay claude` | 切換這個視窗. 只影響目前的 session |
| `/relay default [codex\|claude]` | 查看或設定新 session 的預設路由 |
| `/relay status` | 顯示路由, relay, proxy, 這個視窗的 Codex 用量和方案用量 |
| `/relay usage` | 顯示 Codex 方案的用量上限 |
| `/relay models [--full]` | 列出帳號目前可用的 Codex model, 以及 proxy 是否支援. `--full` 也列出 hidden model |
| `/relay auth [status\|login\|device\|logout]` | Codex 登入. `login` 開啟瀏覽器, `device` 用裝置碼登入 |
| `/relay monitor` | 顯示開啟 monitor TUI 的指令 (需要另一個終端機) |
| `/relay start` · `stop` · `restart` | 控制 relay. `stop` 和 `restart` 加上 `--proxy` 會一併停止 proxy |
| `/relay stop-proxy` | 只停止 proxy, relay 繼續執行. 下一個走 Codex 的 request 會重新啟動 proxy |
| `/relay help` | 列出所有指令 |

### 路由規則

- Session 送出第一個 request 時, 固定使用當下的預設路由. 之後修改預設只影響新的 session. 進行中的對話不會換路徑, 也不會重建 prompt cache.
- 用 `/relay codex` 或 `/relay claude` 明確切換時, 路由立即改變. 從 Codex 切回 Claude 時, 下一輪會重送整段對話並重建 prompt cache.
- Model id 以 `gpt-` 開頭的 request 一律走 Codex, 不論 session 的路由.
- 走 Codex 的 Claude model id (例如 `claude-opus-…`) 會轉成 tier 名稱 (`opus`, `sonnet`, `haiku`, `fable`). Proxy 再依自己的設定對應到 Codex model.

### Subagent

`codex-relay:codex` agent type 在 Codex 上執行, model 由 `agentModel` 指定. 主對話可以留在 Claude.

### Statusline

範例: `⚠ codex-relay: ⇄ Codex gpt-5.6-terra · ctx 42% · 5h 23% · 週 41%`.

- `⚠ codex-relay:` 是 Claude Code 加上的前綴.
- `Codex` 後面是實際回應的 model. Proxy 還沒解析出 model 時, 顯示 request 要求的 model.
- `ctx` 是這個 session 的 context window 使用率.
- `5h` 和 `週` 是方案的用量視窗. 達到上限時顯示 `已達上限`.
- Relay 沒有回應時顯示 `codex-relay 離線: 直連 Claude`.

### Monitor

Monitor 是唯讀的全螢幕 TUI. 它即時顯示 proxy 處理的 request, model 和用量. 在另一個終端機執行:

```sh
claude-code-proxy monitor --url http://127.0.0.1:8970
```

## 設定

### Relay 與 plugin

設定檔是 `~/.claude/codex-relay.json` (有設定 `CLAUDE_CONFIG_DIR` 時放在該目錄). 檔案不存在或 JSON 格式錯誤時, 使用預設值.

| 欄位 | 預設值 | 說明 |
|---|---|---|
| `port` | `8960` | Relay 的 port |
| `proxyPort` | `8970` | Proxy 的 port. Relay 用 `--port` 啟動 proxy |
| `proxyCommand` | `"claude-code-proxy"` | Proxy 執行檔名稱或完整路徑 |
| `defaultRoute` | `"claude"` | 新 session 的路由: `"claude"` 或 `"codex"` |
| `agentModel` | `"gpt-5.6-terra"` | `codex-relay:codex` subagent 使用的 Codex model |
| `claudeUrl` | `"https://api.anthropic.com"` | Claude 路由的上游位址 |
| `nodePath` | `"node"` | Plugin 啟動 relay 時使用的 Node 執行檔 (只有 plugin 讀取) |

修改 `port`, `proxyPort` 或 `proxyCommand` 後, 執行 `/relay restart --proxy`.

### Proxy

Proxy 的設定檔是 `config.json`, 放在下面的目錄. 有設定 `CCP_CONFIG_DIR` 時放在該目錄.

| 平台 | 目錄 |
|---|---|
| Windows | `%APPDATA%\claude-code-proxy` |
| macOS | `~/.config/claude-code-proxy` |
| Linux | `$XDG_CONFIG_HOME/claude-code-proxy` (預設 `~/.config/claude-code-proxy`) |

Codex 的設定放在 `codex` 物件中. 同名的 `CCP_CODEX_*` 環境變數優先於檔案.

| 欄位 | 環境變數 | 說明 |
|---|---|---|
| `model` | `CCP_CODEX_MODEL` | 固定使用的 Codex model |
| `effort` | `CCP_CODEX_EFFORT` | Reasoning effort |
| `serviceTier` | `CCP_CODEX_SERVICE_TIER` | Service tier |
| `reasoningSummary` | `CCP_CODEX_REASONING_SUMMARY` | Reasoning summary 模式 |
| `transport` | `CCP_CODEX_TRANSPORT` | `websocket` (預設), `http` 或 `auto` |
| `headerTimeoutMs` | `CCP_CODEX_HEADER_TIMEOUT_MS` | HTTP transport 等待 response header 的時間. 預設 `300000` |
| `authSource` | `CCP_CODEX_AUTH_SOURCE` | `codex-cli` (預設, 讀 `~/.codex/auth.json`) 或 `proxy` (proxy 自己的登入) |

`authSource` 也可以用 `claude-code-proxy codex auth source [proxy|codex-cli]` 查看或設定. 其他欄位請參考 claude-code-proxy 文件.

### Relay CLI

Relay 也可以直接操作:

```sh
node relay/cli.mjs start | stop [--proxy] | restart [--proxy] | status [--json] | default [claude|codex] | config
```

`config` 印出目前生效的設定.

## 檔案

| 檔案 | 說明 |
|---|---|
| `~/.claude/codex-relay.json` | Relay 與 plugin 的設定 |
| `~/.claude/codex-relay-state.json` | 每個 session 的路由 (保留 7 天) |
| `~/.claude/codex-relay.log` | Relay log (超過 5 MB 會清空) |
| `<proxy 設定目錄>/config.json` | Proxy 設定 |
| `%LOCALAPPDATA%\claude-code-proxy\proxy.log` (Windows) · `~/.local/state/claude-code-proxy/proxy.log` (其他) | Proxy log |

## Plugin 的行為

- Session 開始時, plugin 檢查 relay. Relay 沒有回應時, plugin 在背景啟動它.
- Plugin 只對**這個 session** 設定 `ANTHROPIC_BASE_URL`. 它不修改 `settings.json`. Relay 沒有回應時, session 回到原本的位址.
- `claude plugin update` 之後, 舊版 relay 仍在執行. Plugin 會在 relay 沒有處理中的 request 時, 用新版重新啟動它.
- 另一個 `CLAUDE_CONFIG_DIR` 的 relay 佔用同一個 port 時, plugin 不使用它, 這個 session 直連 Claude. 要同時使用多個 config dir, 請在各自的 `codex-relay.json` 設定不同的 `port`.

## 注意事項

- **Codex 路由不會送出 Claude 的認證**: relay 轉給 proxy 前會移除 `authorization` 和 `x-api-key`.
- **和 model-relay 並用**: 兩者都會設定 `ANTHROPIC_BASE_URL`. 這個 plugin 啟用後, session 改走 codex-relay. 如果要讓 Claude 路由繼續經過 model-relay, 把 `claudeUrl` 設為 model-relay 的位址.
- **只轉譯 model call**: Codex 路由只處理 `POST /v1/messages` 和 `POST /v1/messages/count_tokens`. 其他 request 一律轉給 Anthropic.
- **只接受本機程式**: relay 要求 `Host` 是 `127.0.0.1` 或 `localhost` 加上 relay 的 port, 並拒絕瀏覽器的 request (有 `Origin` 或 `Sec-Fetch-Site` header).

## 文件

- [docs/install.html](docs/install.html): 逐步安裝指南
- [docs/ADRs.md](docs/ADRs.md): proxy 的設計決策與刻意的行為

## 開發

```sh
node --test "relay/*.test.mjs"      # relay 單元與整合測試
claude plugin validate .
claude plugin test .                # hooks 測試
cd proxy && cargo test --all        # proxy 測試
```
