# ADRs

本文件記錄已確認的規格, 以及看起來像 bug, 但其實是刻意設計的行為. 修改這些行為之前, 請先讀對應的 ADR.

- 路徑以 repo 根目錄為準.
- 每個 ADR 包含: 狀態, 背景, 決定, 後果.

## 規格

### ADR-001: 三個 endpoint 用同一組規則套用 codex request config

- 狀態: 採用 (2026-10-22).
- 背景: `/v1/messages`, `/v1/chat/completions` 和 `/v1/responses` 原本各自處理 `CCP_CODEX_MODEL`, `CCP_CODEX_EFFORT`, `CCP_CODEX_SERVICE_TIER`. `/v1/responses` 完全不套用. Monitor 顯示的 effort 也和送到上游的值不同.
- 決定:
  1. Model: 先去掉 `[1m]` 後綴, 再套用 model override, 最後驗證 resolved model. Router 和驗證使用同一個 model.
  2. Effort: 依序套用 client 值 → `CCP_CODEX_EFFORT` 覆寫 → compaction request 的 `CCP_COMPACT_EFFORT` 上限. 規則只寫在 `proxy/src/providers/codex/translate/request.rs` 的 `resolve_codex_effort`.
  3. Service tier: 由 `pick_service_tier` 決定. Config override 優先於 client 送來的值. 沒有 override 時, `-fast` / `-ultrafast` 後綴只在 client 沒有送 tier 時生效.
  4. Monitor 回報 resolved 後的 model 和 effort. Effort 為 `none` 時, monitor 顯示為沒有 effort.
- 後果:
  - Effort override 為 `none` 時, messages 和 native 會送出 `"none"`. Chat 不送這個欄位. 不送欄位時, 上游會使用自己的 default.
  - Chat 沒有 compaction 規則.
  - Native endpoint 只修改上面三個欄位, 其他欄位維持 passthrough.
  - Config 裡的 effort 或 service tier 無效時, 回傳 500 `api_error`.

### ADR-002: Config 的解析規則

- 狀態: 採用 (2026-10-22).
- 背景: 約 20 個 accessor 各自實作 "env > config.json > default". 對空字串, bool 拼法和無效值的處理各不相同.
- 決定: 所有 accessor 都使用 `proxy/src/config.rs` 的 `non_blank`, `env_string`, `parse_bool`, `env_bool`.
  1. 優先順序: env > config.json > default.
  2. 去掉值前後的空白. 空字串或只有空白, 視為未設定.
  3. Bool 接受 `1|true|yes|on` 和 `0|false|no|off`, 不分大小寫.
  4. 無法解析的值視為未設定, 繼續往下一層找 (例如 `PORT=abc` 使用 config.json 的 `port`).
- 後果:
  - `CCP_LOG_VERBOSE=0` 會關閉 verbose. 舊行為是只要有設定就開啟.
  - 例外: `CCP_GROK_TOOL_IMAGE` 和 `CCP_GROK_SEARCH_BLOCKS` 只讀 env. 未知的值使用 default.
  - 測試用 `*_for_env(&env)` 傳入 env map, 不修改 process env.

### ADR-003: Responses-Lite lane 使用明確的欄位

- 狀態: 採用 (2026-10-22).
- 背景: Transport 原本用 `client_metadata.is_some()` 決定 lite header, originator 和 UA. 其他功能設定 `client_metadata` 時, lane 會被切換, 但不會有任何提示.
- 決定:
  1. `ResponsesRequest` 有 `#[serde(skip)] lane: ResponsesLane`. Transport 只讀 `lane.is_lite()`.
  2. `client_metadata` 只由 `ResponsesLane::client_metadata()` 產生. Chat 和 messages 都送 `{"ws_request_header_x_openai_internal_codex_responses_lite":"true"}`.
- 後果: 只設定 `client_metadata` 不會改變 lane. 新增建立 `ResponsesRequest` 的程式碼時, 一定要設定 `lane`.

### ADR-004: Monitor 和 status line 之間的 model contract

- 狀態: 採用 (2026-10-22).
- 背景: Hook 原本用 `split('→')` 解析 monitor 的顯示字串. 只要顯示格式改變, status line 就會壞掉.
- 決定:
  1. Proxy `/monitor` 的 `active`, `recent`, `sessions` 都有 `requested_model` 和 `resolved_model`. Resolve 之前, `resolved_model` 是 `null`.
  2. Relay 把它們轉成 `session.codex.requestedModel` / `resolvedModel`.
  3. `hooks/logic.ts` 的 `answeringModel` 依序讀 `resolvedModel` → `requestedModel`. 兩個都沒有時, 才解析舊的 `→` 字串, 以相容舊版 proxy.
  4. `model` 欄位保留為顯示字串, 給 TUI 和 `/relay status` 使用.
- 後果:
  - Session 摘要的三個 model 欄位都來自同一個 request.
  - `proxy/tests/fixtures/model-contract.mjs` 是 Rust, relay, hook 三邊共用的測試 fixture. 修改 contract 時, 要一起更新這個檔案. 使用 `.mjs` 是因為 `claude plugin test` 不允許 import `.json`.

### ADR-005: Keychain 存取不在 tokio worker 上執行

- 狀態: 採用 (2026-10-22).
- 背景: macOS 讀取 Keychain 會啟動 `/usr/bin/security`, 並同步輪詢最長 10 秒. auth 檔案不存在時, 每個 request 都會阻塞 worker.
- 決定:
  1. `CodexAuthManager` 使用 `load_auth_async` / `clear_auth_async`, 在 `spawn_blocking` 中執行.
  2. `KeychainFileAuthStore` 快取 Keychain 讀取結果 30 秒 (`KEYCHAIN_READ_CACHE_TTL`). 讀取失敗和空結果也會快取. `save` 和 `clear` 會清除快取.
  3. 同時進來的 request 會等同一次讀取完成, 不會各自啟動 `security`.
- 後果:
  - 在 proxy 外部修改 Keychain 後, 最多 30 秒才會生效.
  - `SystemKeychain::write` 一律失敗, 所以 save 一定會寫到 auth 檔案.
  - CLI 的 `logout` 仍然使用同步的 `clear_auth`.

### ADR-006: Streaming 和 non-streaming 共用的轉換規則

- 狀態: 採用 (2026-10-22).
- 背景: 同一個上游回應經過 buffered (`reducer.rs`) 和 live (`live_stream.rs`) translator 時, 可能產生不同的結果.
- 決定:
  1. Tool arguments: 沒有收到 argument delta (`!had_delta`) 時, 使用 `output_item.done` 的 `arguments`. 已收到 delta 時, 保留累積的值.
  2. WS→HTTP fallback: streaming 和 non-streaming 都只透過 `CodexHttpClient::may_fallback_to_http` 決定.
- 後果: 修改其中一個 translator 時, 必須同時修改另一個.

### ADR-007: 每個 request 都要寫 completion log

- 狀態: 採用 (2026-10-22).
- 決定: `/v1/responses`, chat completions 和 transcription 的所有 early return (model 解析失敗, unknown model, 驗證失敗, multipart 欄位錯誤) 都要寫 `request_completed` log.
- 後果: 新增 early return 時, 必須同時寫 completion log.

### ADR-008: Log redaction 的截斷規則

- 狀態: 採用 (2026-10-22).
- 決定: 非 verbose 模式下, 超過 4000 bytes 的欄位會被截斷. 截斷位置從 4000 往前找到最近的 char boundary.
- 後果: 截斷後的長度可能少於 4000 bytes. 這是正常行為.

## 刻意的行為 (不是 bug)

### ADR-009: Transcription 的 originator 固定為 `Codex Desktop`

- 狀態: 採用.
- 行為: `proxy/src/providers/codex/client.rs` 的 transcription header 固定送 `originator: Codex Desktop`, 不使用 `CCP_CODEX_ORIGINATOR`. Image endpoint 則會使用 `CCP_CODEX_ORIGINATOR`.
- 原因: 這是在模仿 Codex Desktop 的請求. `transcription.rs` 的測試斷言這個值. 上游是否接受其他 originator 目前未知.
- 修改前: 先確認上游接受其他 originator.

### ADR-010: Messages endpoint 只讀 `x-claude-code-session-id`

- 狀態: 採用.
- 行為: Messages 只從 `x-claude-code-session-id` 取得 session id. 其他 endpoint (`native_session_id`) 依序讀 `x-claude-code-session-id`, `session_id`, `x-client-request-id`. 所有 endpoint 都把空字串視為沒有 session id.
- 原因: Claude Code 每個 request 都會送不同的 `x-client-request-id`. 如果 messages 也 fallback 到這個 header, 每個 request 都會變成新的 session, sticky routing 和 prompt cache 都會失效.

### ADR-011: SSE 解析的已知限制

- 狀態: 採用.
- 行為:
  - `count_sse_events` 只計算以 `event:` 開頭的行. JSON 內文中的 `event:` 不計入.
  - `monitor.rs` 的 `usage_from_anthropic_sse` 逐行讀取 `data:`, 不合併多行 data.
  - `openai_compat/stream.rs` 的分隔符號使用 buffer 中最早出現的 `\n\n` 或 `\r\n\r\n`. 不支援單獨的 `\r` 換行.
- 原因: Proxy 輸出的 JSON 不包含換行, 所以不會產生多行 data. Production 只註冊 codex provider, `openai_compat` 的 stream 目前只有測試會執行.

### ADR-012: 整合測試的 effort 斷言受本機 config 影響

- 狀態: 已知限制.
- 行為: 整合測試 (例如 `proxy/tests/server.rs` 的 `monitor_records_successful_request_events`) 斷言的 effort 會受開發者本機 config 影響. 本機設定 codex effort 時, 測試可能失敗.
- 原因: 整合測試在獨立的 process 中執行. `AppState` 目前不能注入 config. Chat 的整合測試也有相同的依賴.
- 解法: 執行測試前, 先移除本機的 codex effort 設定. 如果要完全避免這個問題, 需要讓 `AppState` 可以注入 config.
