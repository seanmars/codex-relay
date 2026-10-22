#Requires -Version 7
# codex-relay 的 Windows 安裝腳本. 需要 PowerShell 7 (pwsh).
# 腳本先檢查每個工具, 只安裝缺少的部分. 每個指令執行前都會顯示內容和原因, 並等待確認.
#
# 用法 (在 pwsh 中擇一):
#   irm https://raw.githubusercontent.com/seanmars/codex-relay/main/scripts/install.ps1 | iex
#   pwsh -ExecutionPolicy Bypass -File scripts\install.ps1

$RepoUrl = 'https://github.com/seanmars/codex-relay.git'
$PluginId = 'codex-relay@codex-relay'
$StepCount = 6

function Write-Step([int]$No, [string]$Title) {
    Write-Host ''
    Write-Host "== 步驟 $No/$StepCount`: $Title ==" -ForegroundColor Yellow
}

function Write-Ok([string]$Message) { Write-Host "  [OK]   $Message" -ForegroundColor Green }
function Write-Missing([string]$Message) { Write-Host "  [缺少] $Message" -ForegroundColor Red }
function Write-Note([string]$Message) { Write-Host "  $Message" -ForegroundColor Gray }

function Confirm-Action([string]$Question, [switch]$DefaultNo) {
    $hint = if ($DefaultNo) { '[y/N]' } else { '[Y/n]' }
    while ($true) {
        $answer = "$(Read-Host "  $Question $hint")".Trim().ToLower()
        if ($answer -eq '') { return -not $DefaultNo }
        if ($answer -eq 'y' -or $answer -eq 'yes') { return $true }
        if ($answer -eq 'n' -or $answer -eq 'no') { return $false }
        Write-Host '  請輸入 y 或 n.'
    }
}

# Show the command and the reason, ask, then run it. Throws when the command fails.
# Never capture this function's output: native tools such as rustup-init need the console directly.
function Invoke-Confirmed([string]$Command, [string]$Reason, [scriptblock]$Action, [switch]$DefaultNo) {
    Write-Host "  將執行: $Command" -ForegroundColor Cyan
    Write-Host "  原因:   $Reason"
    if (-not (Confirm-Action '執行這個指令?' -DefaultNo:$DefaultNo)) {
        Write-Note '已略過.'
        return
    }
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "指令失敗 (exit code $LASTEXITCODE): $Command" }
    Update-SessionPath
}

# Resolve only .exe/.cmd files: npm also installs .ps1 shims, and a strict execution policy blocks them.
function Find-Tool([string]$Name) {
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.exe', '.cmd', '.bat' } |
        Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-ToolVersion([string]$Path) {
    $out = & $Path --version 2>$null | Select-Object -First 1
    if (-not $out) { return '(無法取得版本)' }
    return "$out".Trim()
}

# Installers update the registry PATH, not this session. Append the new entries without dropping existing ones.
function Update-SessionPath {
    $entries = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';'
        [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
        (Join-Path $env:USERPROFILE '.cargo\bin')
        (Join-Path $env:USERPROFILE '.local\bin')
    )
    $current = $env:Path -split ';'
    foreach ($entry in $entries) {
        if ($entry -and ($current -notcontains $entry) -and (Test-Path $entry)) {
            $env:Path = "$env:Path;$entry"
            $current += $entry
        }
    }
}

function Read-JsonOutput([scriptblock]$Action) {
    try { return (& $Action | Out-String | ConvertFrom-Json) } catch { return $null }
}

function Show-Tools {
    $tools = @(
        @{ Name = 'node'; Why = 'Relay 和 plugin 用 Node 執行, 需要 v20 以上' }
        @{ Name = 'git'; Why = '下載原始碼' }
        @{ Name = 'claude'; Why = 'Claude Code' }
        @{ Name = 'cargo'; Why = '編譯 proxy' }
        @{ Name = 'codex'; Why = 'Codex CLI, 提供 ChatGPT 登入' }
        @{ Name = 'claude-code-proxy'; Why = 'codex-relay 的 proxy' }
    )
    foreach ($tool in $tools) {
        $path = Find-Tool $tool.Name
        if ($path) { Write-Ok "$($tool.Name) $(Get-ToolVersion $path)" }
        else { Write-Missing "$($tool.Name): $($tool.Why)" }
    }
}

function Test-NodeVersion([string]$NodePath) {
    $raw = (Get-ToolVersion $NodePath).TrimStart('v')
    try { return ([version]$raw).Major -ge 20 } catch { return $false }
}

function Install-WithWinget([string]$Id, [string]$Label, [string]$ManualUrl) {
    $winget = Find-Tool 'winget'
    if (-not $winget) {
        Write-Missing "winget. 請從 Microsoft Store 安裝「應用程式安裝程式」, 或到 $ManualUrl 手動安裝 $Label."
        return
    }
    Invoke-Confirmed "winget install --id $Id --exact --source winget" "用 Windows 內建的 winget 安裝 $Label." {
        & $winget install --id $Id --exact --source winget
    }
}

function Install-Base {
    Write-Step 2 '安裝 Node.js, Git 與 Claude Code'

    $node = Find-Tool 'node'
    if (-not $node) {
        Write-Missing 'Node.js'
        Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS (含 npm)' 'https://nodejs.org/en/download'
    } elseif (-not (Test-NodeVersion $node)) {
        Write-Missing "Node.js v20 以上. 目前是 $(Get-ToolVersion $node)."
        Write-Note '請用你原本安裝 Node.js 的方式升級, 或到 https://nodejs.org/en/download 下載 LTS 版本.'
    } else {
        Write-Ok "Node.js $(Get-ToolVersion $node)"
    }

    $git = Find-Tool 'git'
    if (-not $git) {
        Write-Missing 'Git'
        Install-WithWinget 'Git.Git' 'Git for Windows' 'https://git-scm.com/downloads/win'
    } else {
        Write-Ok (Get-ToolVersion $git)
    }

    $claude = Find-Tool 'claude'
    if (-not $claude) {
        Write-Missing 'Claude Code'
        Invoke-Confirmed 'irm https://claude.ai/install.ps1 | iex' '下載並執行 Claude Code 的官方安裝程式.' {
            Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
        }
    } else {
        Write-Ok "Claude Code $(Get-ToolVersion $claude)"
        Invoke-Confirmed 'claude update' 'Plugin 需要支援 plugin hooks module 的版本 (已在 2.1.306 測試). 版本太舊時請更新.' {
            & $claude update
        } -DefaultNo
    }
}

function Install-Rust {
    Write-Step 3 '安裝 Rust toolchain'

    $cargo = Find-Tool 'cargo'
    if ($cargo) {
        Write-Ok (Get-ToolVersion $cargo)
        return
    }
    Write-Missing 'Rust toolchain'

    $target = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    $url = "https://static.rust-lang.org/rustup/dist/$target/rustup-init.exe"
    $exe = Join-Path $env:TEMP 'codex-relay-install\rustup-init.exe'
    Write-Note "會從 rust-lang.org 下載 $target 版本的 rustup-init.exe, 然後在這個視窗執行它."
    Write-Note '電腦缺少 MSVC 時, rustup-init 會提示安裝 Visual Studio. 請依照提示, 使用預設選項完成安裝.'
    Invoke-Confirmed "下載 $url 並執行" 'rustup 是 Rust 的官方安裝程式, 會安裝 rustc 和 cargo.' {
        New-Item -ItemType Directory -Force (Split-Path $exe) | Out-Null
        Invoke-WebRequest $url -OutFile $exe
        & $exe
    }
}

function Install-Codex {
    Write-Step 4 '安裝 Codex CLI 並登入 ChatGPT'

    $codex = Find-Tool 'codex'
    if (-not $codex) {
        Write-Missing 'Codex CLI'
        $npm = Find-Tool 'npm'
        if (-not $npm) {
            Write-Note '需要 npm. 請先完成步驟 2 的 Node.js 安裝, 再重新執行這個腳本.'
            return
        }
        Invoke-Confirmed 'npm install -g @openai/codex' '用 npm 全域安裝 OpenAI 的 Codex CLI.' {
            & $npm install -g '@openai/codex'
        }
        $codex = Find-Tool 'codex'
        if (-not $codex) { return }
    } else {
        Write-Ok "Codex CLI $(Get-ToolVersion $codex)"
    }

    & $codex login status *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok 'Codex 已經登入.'
        return
    }
    Write-Missing 'Codex 登入'
    Invoke-Confirmed 'codex login' '開啟瀏覽器, 用有 Codex 使用權的 ChatGPT 帳號登入. Proxy 會讀取這個登入.' {
        & $codex login
    }
}

# Windows cannot replace a running .exe, so cargo install fails with "存取被拒 (os error 5)".
# Stop only the proxy: the relay keeps serving sessions and starts the proxy again on the next Codex request.
function Stop-RunningProxy {
    $running = @(Get-Process -Name 'claude-code-proxy' -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return }
    $ids = ($running | ForEach-Object { $_.Id }) -join ', '
    Write-Note "claude-code-proxy 正在執行 (pid $ids). Windows 不能覆蓋執行中的執行檔."
    Invoke-Confirmed "Stop-Process -Id $ids" '停止 proxy 才能安裝新版. Relay 會在下一次需要 Codex 時, 用新版重新啟動 proxy. 編譯期間請不要使用 Codex session.' {
        $running | Stop-Process -Force
        $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    }
}

# Use the clone this script runs from, or the current directory when it is a clone; otherwise ask where to clone.
function Get-RepoDir {
    $candidates = @((Get-Location).Path)
    if ($PSScriptRoot) { $candidates = @((Split-Path $PSScriptRoot -Parent)) + $candidates }
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir 'proxy\Cargo.toml')) { return $dir }
    }
    $default = Join-Path (Get-Location).Path 'codex-relay'
    $answer = "$(Read-Host "  原始碼要放在哪個資料夾? 直接按 Enter 使用 $default")".Trim()
    if (-not $answer) { return $default }
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($answer)
}

function Install-Proxy {
    Write-Step 5 '下載原始碼並安裝 proxy'

    $cargo = Find-Tool 'cargo'
    if (-not $cargo) {
        Write-Note '需要 cargo. 請先完成步驟 3, 再重新執行這個腳本.'
        return
    }

    $repo = Get-RepoDir
    if (Test-Path (Join-Path $repo 'proxy\Cargo.toml')) {
        Write-Ok "使用原始碼: $repo"
    } else {
        $git = Find-Tool 'git'
        if (-not $git) {
            Write-Note '需要 git. 請先完成步驟 2, 再重新執行這個腳本.'
            return
        }
        Invoke-Confirmed "git clone $RepoUrl `"$repo`"" '下載 codex-relay 的原始碼.' {
            & $git clone $RepoUrl $repo
        }
        if (-not (Test-Path (Join-Path $repo 'proxy\Cargo.toml'))) { return }
    }

    $proxyDir = Join-Path $repo 'proxy'
    $proxy = Find-Tool 'claude-code-proxy'
    if ($proxy) {
        Write-Ok "已經安裝 $(Get-ToolVersion $proxy)"
        if (Confirm-Action '要用目前的原始碼重新編譯並覆蓋已安裝的 proxy 嗎? 只有要更新時才需要.' -DefaultNo) {
            Stop-RunningProxy
            Invoke-Confirmed "cargo install --path `"$proxyDir`" --force" '重新編譯並覆蓋已安裝的 proxy. --force 讓 cargo 在版本號碼相同時也重新安裝.' {
                & $cargo install --path $proxyDir --force
            }
        } else {
            Write-Note '已略過.'
        }
    } else {
        Invoke-Confirmed "cargo install --path `"$proxyDir`"" '編譯 proxy 並安裝到 %USERPROFILE%\.cargo\bin. 第一次編譯需要幾分鐘.' {
            & $cargo install --path $proxyDir
        }
    }

    $proxy = Find-Tool 'claude-code-proxy'
    if ($proxy) {
        Write-Note '檢查 proxy 是否讀得到 Codex 登入:'
        & $proxy codex auth status
    }
}

function Install-Plugin {
    Write-Step 6 '安裝 Claude Code plugin'

    $claude = Find-Tool 'claude'
    if (-not $claude) {
        Write-Note '需要 Claude Code. 請先完成步驟 2, 再重新執行這個腳本.'
        return
    }

    $markets = Read-JsonOutput { & $claude plugin marketplace list --json }
    if ($markets | Where-Object { $_.name -eq 'codex-relay' }) {
        Write-Ok 'Marketplace codex-relay 已經加入.'
    } else {
        Invoke-Confirmed 'claude plugin marketplace add seanmars/codex-relay' '讓 Claude Code 從 GitHub 的 seanmars/codex-relay 讀取 plugin.' {
            & $claude plugin marketplace add seanmars/codex-relay
        }
    }

    $plugin = Read-JsonOutput { & $claude plugin list --json } | ForEach-Object { $_ } | Where-Object { $_.id -eq $PluginId }
    if (-not $plugin) {
        Invoke-Confirmed "claude plugin install $PluginId" '安裝 plugin. 它提供 /relay 指令, 面板, statusline 和 codex-relay:codex subagent.' {
            & $claude plugin install $PluginId
        }
    } elseif (-not $plugin.enabled) {
        Invoke-Confirmed "claude plugin enable $PluginId" 'Plugin 已經安裝, 但是停用中.' {
            & $claude plugin enable $PluginId
        }
    } else {
        Write-Ok "Plugin $PluginId $($plugin.version) 已經啟用."
    }
}

function Install-CodexRelay {
    # `irm | iex` skips #Requires, so check the version here too.
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        Write-Host '這個腳本需要 PowerShell 7. 請執行 winget install --id Microsoft.PowerShell --exact --source winget 安裝, 然後在 pwsh 中重新執行.'
        return
    }
    if ($env:OS -ne 'Windows_NT') {
        Write-Host '這個腳本只支援 Windows. macOS 和 Linux 請在 bash 中執行 scripts/install.sh.'
        return
    }

    Write-Host 'codex-relay 安裝腳本' -ForegroundColor Yellow
    Write-Host '腳本會先檢查每個工具, 只安裝缺少的部分. 每個指令執行前都會詢問你. 按 Ctrl+C 可以隨時停止.'

    Update-SessionPath
    Write-Step 1 '檢查現有工具'
    Show-Tools

    Install-Base
    Install-Rust
    Install-Codex
    Install-Proxy
    Install-Plugin

    Write-Host ''
    Write-Host '== 完成 ==' -ForegroundColor Yellow
    Show-Tools
    Write-Host ''
    Write-Host '下一步:'
    Write-Host '  1. 開啟新的終端機, 讓 PATH 生效.'
    Write-Host '  2. 執行 claude 開啟新的 session.'
    Write-Host '  3. 在 Claude Code 中執行 /relay status 確認狀態.'
    Write-Host '有工具還是顯示 [缺少] 時, 請重新開啟終端機, 再執行一次這個腳本.'
}

# Claude's JSON output is UTF-8. Restore the console encoding afterwards because `irm | iex` runs in the caller's session.
$previousEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Install-CodexRelay
} catch {
    Write-Host ''
    Write-Host "安裝中止: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '修正問題後, 重新執行這個腳本. 已經完成的步驟會自動略過.'
} finally {
    [Console]::OutputEncoding = $previousEncoding
}
