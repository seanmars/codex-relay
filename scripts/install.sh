#!/usr/bin/env bash
# codex-relay 的 macOS / Linux 安裝腳本. 需要 bash 3.2 以上 (macOS 內建的版本可以使用).
# 腳本先檢查每個工具, 只安裝缺少的部分. 每個指令執行前都會顯示內容和原因, 並等待確認.
#
# 用法 (擇一):
#   curl -fsSL https://raw.githubusercontent.com/seanmars/codex-relay/main/scripts/install.sh | bash
#   bash scripts/install.sh

# `curl | sh` runs this under dash, which cannot parse the rest. This check uses POSIX syntax only.
if [ -z "${BASH_VERSION:-}" ]; then
    echo '這個腳本需要 bash. 請改用: curl -fsSL https://raw.githubusercontent.com/seanmars/codex-relay/main/scripts/install.sh | bash'
    exit 1
fi

REPO_URL='https://github.com/seanmars/codex-relay.git'
PLUGIN_ID='codex-relay@codex-relay'
STEP_COUNT=6

OS=''   # mac | linux
SUDO='' # "sudo" unless the script already runs as root

if [ -t 1 ]; then
    C_YELLOW=$'\033[33m' C_GREEN=$'\033[32m' C_RED=$'\033[31m' C_CYAN=$'\033[36m' C_GRAY=$'\033[90m' C_RESET=$'\033[0m'
else
    C_YELLOW='' C_GREEN='' C_RED='' C_CYAN='' C_GRAY='' C_RESET=''
fi

write_step() { printf '\n%s== 步驟 %s/%s: %s ==%s\n' "$C_YELLOW" "$1" "$STEP_COUNT" "$2" "$C_RESET"; }
write_ok() { printf '  %s[OK]   %s%s\n' "$C_GREEN" "$1" "$C_RESET"; }
write_missing() { printf '  %s[缺少] %s%s\n' "$C_RED" "$1" "$C_RESET"; }
write_note() { printf '  %s%s%s\n' "$C_GRAY" "$1" "$C_RESET"; }

fail() {
    printf '\n%s安裝中止: %s%s\n' "$C_RED" "$1" "$C_RESET"
    echo '修正問題後, 重新執行這個腳本. 已經完成的步驟會自動略過.'
    exit 1
}

# `curl | bash` feeds this script on stdin, so every answer is read from the terminal instead.
read_answer() {
    printf '%s' "$1"
    REPLY=''
    IFS= read -r REPLY < /dev/tty || REPLY=''
}

# $1 question, $2 default answer (y|n). Returns 0 for yes.
confirm() {
    local hint='[Y/n]' answer
    [ "$2" = n ] && hint='[y/N]'
    while true; do
        read_answer "  $1 $hint "
        answer=$(printf '%s' "$REPLY" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
        case "$answer" in
            '') [ "$2" != n ]; return ;;
            y | yes) return 0 ;;
            n | no) return 1 ;;
        esac
        echo '  請輸入 y 或 n.'
    done
}

# Show the command and the reason, ask, then run it. Exits the script when the command fails.
# $1 default answer (y|n), $2 command shown to the user, $3 reason, rest: the command to run.
# Installers such as rustup and codex login read the terminal, so stdin comes from /dev/tty.
run_confirmed() {
    local default=$1 shown=$2 reason=$3 code
    shift 3
    printf '  %s將執行: %s%s\n' "$C_CYAN" "$shown" "$C_RESET"
    printf '  原因:   %s\n' "$reason"
    if ! confirm '執行這個指令?' "$default"; then
        write_note '已略過.'
        return 0
    fi
    "$@" < /dev/tty
    code=$?
    [ "$code" -eq 0 ] || fail "指令失敗 (exit code $code): $shown"
    update_session_path
}

# `type -P` resolves files only, so shell aliases and functions never shadow a tool.
# Checks that need no answer read stdin from /dev/null: under `curl | bash`, stdin is this script,
# and a tool that reads it would also take the answers meant for later prompts.
find_tool() { type -P "$1" 2> /dev/null; }

tool_version() {
    local out
    out=$("$1" --version < /dev/null 2> /dev/null | head -n 1)
    if [ -z "$out" ]; then
        echo '(無法取得版本)'
        return 1
    fi
    echo "$out"
}

# Installers add PATH entries to shell profiles, not to this process. Append the known install directories.
update_session_path() {
    local dir
    for dir in "$HOME/.cargo/bin" "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin; do
        case ":$PATH:" in *":$dir:"*) continue ;; esac
        [ -d "$dir" ] && PATH="$PATH:$dir"
    done
    export PATH
}

detect_platform() {
    case "$(uname -s)" in
        Darwin) OS=mac ;;
        Linux) OS=linux ;;
        *) return 1 ;;
    esac
    [ "$(id -u)" -eq 0 ] || SUDO='sudo'
}

# A tool that cannot print its version counts as missing. On macOS, /usr/bin/git exists
# without the Command Line Tools but only opens an install dialog.
show_tool() {
    local path version
    if path=$(find_tool "$1") && version=$(tool_version "$path"); then
        write_ok "$1 $version"
    else
        write_missing "$1: $2"
    fi
}

show_tools() {
    show_tool node 'Relay 和 plugin 用 Node 執行, 需要 v20 以上'
    show_tool git '下載原始碼'
    show_tool claude 'Claude Code'
    show_tool cargo '編譯 proxy'
    show_tool codex 'Codex CLI, 提供 ChatGPT 登入'
    show_tool claude-code-proxy 'codex-relay 的 proxy'
}

node_version_ok() {
    local major
    major=$(tool_version "$1" | sed -E 's/^v([0-9]+).*/\1/')
    case "$major" in '' | *[!0-9]*) return 1 ;; esac
    [ "$major" -ge 20 ]
}

has_mac_clt() { xcode-select -p > /dev/null 2>&1; }

install_with_brew() { # $1 formula, $2 label, $3 manual download URL
    local brew
    if ! brew=$(find_tool brew); then
        write_missing "Homebrew. 請依照 https://brew.sh 安裝, 或到 $3 手動安裝 $2."
        return 0
    fi
    run_confirmed y "brew install $1" "用 Homebrew 安裝 $2." "$brew" install "$1"
}

linux_package_manager() {
    local pm
    for pm in apt-get dnf pacman zypper; do
        if find_tool "$pm" > /dev/null; then
            echo "$pm"
            return 0
        fi
    done
    return 1
}

# $1 label, then the package name for apt-get, dnf, pacman and zypper.
install_linux_package() {
    local label=$1 pm sudo=${SUDO:+$SUDO }
    if ! pm=$(linux_package_manager); then
        write_missing "支援的套件管理工具 (apt-get, dnf, pacman, zypper). 請手動安裝 $label."
        return 0
    fi
    case "$pm" in
        apt-get)
            run_confirmed y "${sudo}apt-get update && ${sudo}apt-get install -y $2" "用 apt 安裝 $label." \
                sh -c "${sudo}apt-get update && ${sudo}apt-get install -y $2"
            ;;
        dnf) run_confirmed y "${sudo}dnf install -y $3" "用 dnf 安裝 $label." $SUDO dnf install -y "$3" ;;
        pacman) run_confirmed y "${sudo}pacman -S --needed --noconfirm $4" "用 pacman 安裝 $label." $SUDO pacman -S --needed --noconfirm "$4" ;;
        zypper) run_confirmed y "${sudo}zypper install -y $5" "用 zypper 安裝 $label." $SUDO zypper install -y "$5" ;;
    esac
}

install_node() {
    local node
    if ! node=$(find_tool node); then
        write_missing 'Node.js'
        if [ "$OS" = mac ]; then
            install_with_brew node 'Node.js (含 npm)' 'https://nodejs.org/en/download'
        else
            write_note '發行版內建的 Node.js 常常低於 v20. 請到 https://nodejs.org/en/download 選擇 Linux, 依照頁面上的指令安裝 LTS 版本.'
        fi
    elif ! node_version_ok "$node"; then
        write_missing "Node.js v20 以上. 目前是 $(tool_version "$node")."
        write_note '請用你原本安裝 Node.js 的方式升級, 或到 https://nodejs.org/en/download 下載 LTS 版本.'
    else
        write_ok "Node.js $(tool_version "$node")"
    fi
}

# macOS ships git and the C linker in the Command Line Tools.
install_git() {
    local git
    if [ "$OS" = mac ] && ! has_mac_clt; then
        write_missing 'Git (Apple Command Line Tools)'
        run_confirmed y 'xcode-select --install' '安裝 Apple Command Line Tools, 內含 git 和 Rust 需要的 C linker. 請在跳出的視窗完成安裝, 再重新執行這個腳本.' \
            xcode-select --install
        return 0
    fi
    if git=$(find_tool git); then
        write_ok "$(tool_version "$git")"
        return 0
    fi
    write_missing 'Git'
    install_linux_package 'Git' git git git git
}

install_curl() {
    local curl
    if curl=$(find_tool curl); then
        write_ok "$(tool_version "$curl")"
        return 0
    fi
    write_missing 'curl: 下載 Claude Code 和 Rust 的安裝程式'
    install_linux_package 'curl' curl curl curl curl
}

install_claude() {
    local claude
    if claude=$(find_tool claude); then
        write_ok "Claude Code $(tool_version "$claude")"
        run_confirmed n 'claude update' 'Plugin 需要支援 plugin hooks module 的版本 (已在 2.1.306 測試). 版本太舊時請更新.' \
            "$claude" update
        return 0
    fi
    write_missing 'Claude Code'
    if ! find_tool curl > /dev/null; then
        write_note '需要 curl. 請先安裝 curl, 再重新執行這個腳本.'
        return 0
    fi
    run_confirmed y 'curl -fsSL https://claude.ai/install.sh | bash' '下載並執行 Claude Code 的官方安裝程式.' \
        bash -c 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'
}

install_base() {
    write_step 2 '安裝 Node.js, Git 與 Claude Code'
    install_node
    install_git
    [ "$OS" = linux ] && install_curl
    install_claude
}

install_linker() {
    local cc
    if [ "$OS" = mac ]; then
        if has_mac_clt; then
            write_ok 'C linker (Apple Command Line Tools)'
        else
            write_missing 'C linker. 請先完成步驟 2 的 Apple Command Line Tools 安裝, 再重新執行這個腳本.'
        fi
        return 0
    fi
    if cc=$(find_tool cc); then
        write_ok "C linker: $(tool_version "$cc")"
        return 0
    fi
    write_missing 'C compiler 和 linker: Rust 編譯時需要'
    install_linux_package 'C compiler 和 linker' build-essential gcc base-devel gcc
}

install_rust() {
    write_step 3 '安裝 Rust toolchain'
    install_linker

    local cargo
    if cargo=$(find_tool cargo); then
        write_ok "$(tool_version "$cargo")"
        return 0
    fi
    write_missing 'Rust toolchain'
    if ! find_tool curl > /dev/null; then
        write_note '需要 curl. 請先完成步驟 2, 再重新執行這個腳本.'
        return 0
    fi
    run_confirmed y "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" 'rustup 是 Rust 的官方安裝程式, 會安裝 rustc 和 cargo. 出現選單時, 按 Enter 選擇預設安裝.' \
        bash -c "set -o pipefail; curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
}

install_codex() {
    write_step 4 '安裝 Codex CLI 並登入 ChatGPT'

    local codex npm
    if ! codex=$(find_tool codex); then
        write_missing 'Codex CLI'
        if ! npm=$(find_tool npm); then
            write_note '需要 npm. 請先完成步驟 2 的 Node.js 安裝, 再重新執行這個腳本.'
            return 0
        fi
        run_confirmed y 'npm install -g @openai/codex' '用 npm 全域安裝 OpenAI 的 Codex CLI. 顯示 EACCES 時, 代表 npm 的全域目錄需要 root 權限, 請改用 nvm 等安裝在家目錄的 Node.js.' \
            "$npm" install -g '@openai/codex'
        codex=$(find_tool codex) || return 0
    else
        write_ok "Codex CLI $(tool_version "$codex")"
    fi

    if "$codex" login status < /dev/null > /dev/null 2>&1; then
        write_ok 'Codex 已經登入.'
        return 0
    fi
    write_missing 'Codex 登入'
    run_confirmed y 'codex login' '開啟瀏覽器, 用有 Codex 使用權的 ChatGPT 帳號登入. Proxy 會讀取這個登入.' \
        "$codex" login
}

# Use the clone this script runs from, or the current directory when it is a clone; otherwise ask where to clone.
# `curl | bash` has no script file, so only the current directory is checked then.
get_repo_dir() {
    local src=${BASH_SOURCE[0]:-} dir candidates=()
    if [ -n "$src" ] && [ -f "$src" ]; then
        candidates+=("$(cd "$(dirname "$src")/.." && pwd)")
    fi
    candidates+=("$PWD")
    for dir in "${candidates[@]}"; do
        if [ -f "$dir/proxy/Cargo.toml" ]; then
            echo "$dir"
            return 0
        fi
    done
    local default="$PWD/codex-relay"
    read_answer "  原始碼要放在哪個資料夾? 直接按 Enter 使用 $default: " > /dev/tty
    dir=$(printf '%s' "$REPLY" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    case "$dir" in
        '') dir=$default ;;
        '~') dir=$HOME ;;
        '~/'*) dir="$HOME/${dir#\~/}" ;;
        /*) ;;
        *) dir="$PWD/$dir" ;;
    esac
    echo "$dir"
}

install_proxy() {
    write_step 5 '下載原始碼並安裝 proxy'

    local cargo git repo proxy_dir proxy
    if ! cargo=$(find_tool cargo); then
        write_note '需要 cargo. 請先完成步驟 3, 再重新執行這個腳本.'
        return 0
    fi

    repo=$(get_repo_dir)
    if [ -f "$repo/proxy/Cargo.toml" ]; then
        write_ok "使用原始碼: $repo"
    else
        if ! git=$(find_tool git); then
            write_note '需要 git. 請先完成步驟 2, 再重新執行這個腳本.'
            return 0
        fi
        run_confirmed y "git clone $REPO_URL \"$repo\"" '下載 codex-relay 的原始碼.' \
            "$git" clone "$REPO_URL" "$repo"
        [ -f "$repo/proxy/Cargo.toml" ] || return 0
    fi

    proxy_dir="$repo/proxy"
    if proxy=$(find_tool claude-code-proxy); then
        write_ok "已經安裝 $(tool_version "$proxy")"
        if confirm '要用目前的原始碼重新編譯並覆蓋已安裝的 proxy 嗎? 只有要更新時才需要.' n; then
            run_confirmed y "cargo install --path \"$proxy_dir\" --force" '重新編譯並覆蓋已安裝的 proxy. --force 讓 cargo 在版本號碼相同時也重新安裝.' \
                "$cargo" install --path "$proxy_dir" --force
            # Unlike Windows, the binary can be replaced while it runs, but the running process keeps the old version.
            if pgrep -x claude-code-proxy > /dev/null 2>&1; then
                write_note '執行中的 proxy 還是舊版. 請在 Claude Code 執行 /relay restart --proxy 換成新版.'
            fi
        else
            write_note '已略過.'
        fi
    else
        run_confirmed y "cargo install --path \"$proxy_dir\"" '編譯 proxy 並安裝到 ~/.cargo/bin. 第一次編譯需要幾分鐘.' \
            "$cargo" install --path "$proxy_dir"
    fi

    if proxy=$(find_tool claude-code-proxy); then
        write_note '檢查 proxy 是否讀得到 Codex 登入:'
        "$proxy" codex auth status < /dev/null
    fi
}

# Read a JSON array on stdin and print "<enabled> <version>" for the entry whose field $1 equals $2.
# Prints nothing when the entry is missing or the JSON is invalid. Node is already required by the relay.
json_find() {
    "$NODE" -e '
        let text = ""
        process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
            try {
                const entry = JSON.parse(text).find((e) => e[process.argv[1]] === process.argv[2])
                if (entry) console.log(`${entry.enabled} ${entry.version ?? ""}`)
            } catch {}
        })' "$1" "$2"
}

install_plugin() {
    write_step 6 '安裝 Claude Code plugin'

    local claude plugin
    if ! claude=$(find_tool claude); then
        write_note '需要 Claude Code. 請先完成步驟 2, 再重新執行這個腳本.'
        return 0
    fi
    if ! NODE=$(find_tool node) || ! tool_version "$NODE" > /dev/null; then
        write_note '需要 Node.js. 請先完成步驟 2, 再重新執行這個腳本.'
        return 0
    fi

    if [ -n "$("$claude" plugin marketplace list --json < /dev/null 2> /dev/null | json_find name codex-relay)" ]; then
        write_ok 'Marketplace codex-relay 已經加入.'
    else
        run_confirmed y 'claude plugin marketplace add seanmars/codex-relay' '讓 Claude Code 從 GitHub 的 seanmars/codex-relay 讀取 plugin.' \
            "$claude" plugin marketplace add seanmars/codex-relay
    fi

    plugin=$("$claude" plugin list --json < /dev/null 2> /dev/null | json_find id "$PLUGIN_ID")
    if [ -z "$plugin" ]; then
        run_confirmed y "claude plugin install $PLUGIN_ID" '安裝 plugin. 它提供 /relay 指令, 面板, statusline 和 codex-relay:codex subagent.' \
            "$claude" plugin install "$PLUGIN_ID"
    elif [ "${plugin%% *}" != true ]; then
        run_confirmed y "claude plugin enable $PLUGIN_ID" 'Plugin 已經安裝, 但是停用中.' \
            "$claude" plugin enable "$PLUGIN_ID"
    else
        write_ok "Plugin $PLUGIN_ID ${plugin#* } 已經啟用."
    fi
}

main() {
    if ! detect_platform; then
        echo '這個腳本只支援 macOS 和 Linux. Windows 請在 PowerShell 7 中執行 scripts/install.ps1.'
        exit 1
    fi
    if ! (: < /dev/tty) 2> /dev/null; then
        echo '這個腳本需要在終端機中執行, 才能詢問你.'
        exit 1
    fi

    printf '%scodex-relay 安裝腳本%s\n' "$C_YELLOW" "$C_RESET"
    echo '腳本會先檢查每個工具, 只安裝缺少的部分. 每個指令執行前都會詢問你. 按 Ctrl+C 可以隨時停止.'

    update_session_path
    write_step 1 '檢查現有工具'
    show_tools

    install_base
    install_rust
    install_codex
    install_proxy
    install_plugin

    echo ''
    printf '%s== 完成 ==%s\n' "$C_YELLOW" "$C_RESET"
    show_tools
    echo ''
    echo '下一步:'
    echo '  1. 開啟新的終端機, 讓 PATH 生效.'
    echo '  2. 執行 claude 開啟新的 session.'
    echo '  3. 在 Claude Code 中執行 /relay status 確認狀態.'
    echo '有工具還是顯示 [缺少] 時, 請重新開啟終端機, 再執行一次這個腳本.'
}

# Everything runs from here, so a partially downloaded script never runs half of its steps.
main "$@"
