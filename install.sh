#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# CUMOB One-Click Installer
# Configures OpenAI Codex or Claude Code to use the CUMOB API
# gateway and installs the cumob-media-generation skill.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours & helpers ────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()  { printf "${CYAN}ℹ ${NC}%s\n" "$*"; }
ok()    { printf "${GREEN}✔ ${NC}%s\n" "$*"; }
warn()  { printf "${YELLOW}⚠ ${NC}%s\n" "$*"; }
err()   { printf "${RED}✘ ${NC}%s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

# ── Locate this script (= skill root) ───────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR"

# ── Constants ────────────────────────────────────────────────
CUMOB_BASE_URL="https://api.cumob.com/v1"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_HOME="$HOME/.claude"

# ── Platform detection ───────────────────────────────────────
detect_platforms() {
  HAS_CODEX=false
  HAS_CLAUDE=false

  # Codex: check for CLI or config directory
  if command -v codex &>/dev/null || [ -d "$CODEX_HOME" ]; then
    HAS_CODEX=true
  fi

  # Claude Code: check for CLI or config directory
  if command -v claude &>/dev/null || [ -d "$CLAUDE_HOME" ]; then
    HAS_CLAUDE=true
  fi
}

# ── Interactive platform selection ───────────────────────────
select_platform() {
  detect_platforms

  echo ""
  printf "${BOLD}╔══════════════════════════════════════════════╗${NC}\n"
  printf "${BOLD}║       CUMOB One-Click Installer  v1.0        ║${NC}\n"
  printf "${BOLD}╚══════════════════════════════════════════════╝${NC}\n"
  echo ""

  # Show detected platforms
  if $HAS_CODEX; then
    ok "检测到 OpenAI Codex  (Detected OpenAI Codex)"
  else
    warn "未检测到 OpenAI Codex  (OpenAI Codex not detected)"
  fi

  if $HAS_CLAUDE; then
    ok "检测到 Claude Code   (Detected Claude Code)"
  else
    warn "未检测到 Claude Code   (Claude Code not detected)"
  fi

  echo ""

  # If neither detected, let user choose anyway
  if ! $HAS_CODEX && ! $HAS_CLAUDE; then
    warn "未检测到任何已安装的平台，但你仍可选择要配置的目标平台。"
    warn "No installed platform detected, but you can still choose a target."
    echo ""
  fi

  printf "${BOLD}请选择安装目标 / Select installation target:${NC}\n"
  echo ""
  echo "  1) OpenAI Codex"
  echo "  2) Claude Code"
  if $HAS_CODEX && $HAS_CLAUDE; then
    echo "  3) 两者都安装 / Install for both"
  fi
  echo "  q) 退出 / Quit"
  echo ""

  while true; do
    printf "${CYAN}请输入选项 / Enter choice [1/2${HAS_CODEX:+${HAS_CLAUDE:+/3}}/q]: ${NC}"
    read -r choice
    case "$choice" in
      1) TARGETS=(codex);       break ;;
      2) TARGETS=(claude-code); break ;;
      3)
        if $HAS_CODEX && $HAS_CLAUDE; then
          TARGETS=(codex claude-code); break
        else
          err "该选项仅在两个平台都检测到时可用 / Option 3 requires both platforms detected"
        fi
        ;;
      q|Q) info "已取消 / Cancelled."; exit 0 ;;
      *)  err "无效选项，请重新输入 / Invalid choice, try again." ;;
    esac
  done
}

# ── Collect API key ──────────────────────────────────────────
collect_api_key() {
  # Check existing sources
  if [ -n "${CUMOB_API_KEY:-}" ]; then
    ok "已从环境变量 CUMOB_API_KEY 读取 API Key"
    API_KEY="$CUMOB_API_KEY"
    return
  fi
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    ok "已从环境变量 OPENAI_API_KEY 读取 API Key"
    API_KEY="$OPENAI_API_KEY"
    return
  fi
  if [ -f "$CODEX_HOME/auth.json" ]; then
    local existing
    existing=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('OPENAI_API_KEY',''))" "$CODEX_HOME/auth.json" 2>/dev/null || true)
    if [ -n "$existing" ]; then
      ok "已从 Codex auth.json 读取 API Key"
      API_KEY="$existing"
      return
    fi
  fi

  echo ""
  printf "${BOLD}请输入你的 CUMOB API Key / Enter your CUMOB API Key:${NC}\n"
  printf "${CYAN}(可从 https://cumob.com 获取 / Get it from https://cumob.com)${NC}\n"
  while true; do
    printf "> "
    read -r API_KEY
    if [ -n "$API_KEY" ]; then
      break
    fi
    err "API Key 不能为空 / API Key cannot be empty"
  done
}

# ── Configure Codex ──────────────────────────────────────────
configure_codex() {
  info "正在配置 OpenAI Codex …  (Configuring OpenAI Codex …)"

  mkdir -p "$CODEX_HOME"

  # ── config.toml ──
  local CONFIG_FILE="$CODEX_HOME/config.toml"
  local PROVIDER_NAME="cumob"

  if [ -f "$CONFIG_FILE" ]; then
    # Check if cumob provider already exists
    if grep -q "\[model_providers\.cumob\]" "$CONFIG_FILE" 2>/dev/null; then
      info "Codex config.toml 中已有 cumob provider，正在更新 …"
      # Update base_url in existing section
      sed -i.bak "s|^base_url = .*# cumob|base_url = \"$CUMOB_BASE_URL\" # cumob|" "$CONFIG_FILE" 2>/dev/null || true
    else
      info "向 Codex config.toml 添加 cumob provider …"
      cat >> "$CONFIG_FILE" << EOF

model_provider = "cumob"

[model_providers.cumob]
base_url = "$CUMOB_BASE_URL" # cumob
EOF
    fi
  else
    info "创建 Codex config.toml …"
    cat > "$CONFIG_FILE" << EOF
model_provider = "cumob"

[model_providers.cumob]
base_url = "$CUMOB_BASE_URL" # cumob
EOF
  fi

  # Ensure model_provider points to cumob
  if grep -q '^model_provider' "$CONFIG_FILE"; then
    sed -i.bak 's/^model_provider = .*/model_provider = "cumob"/' "$CONFIG_FILE"
  fi
  rm -f "${CONFIG_FILE}.bak"

  # ── auth.json ──
  local AUTH_FILE="$CODEX_HOME/auth.json"
  if [ -f "$AUTH_FILE" ]; then
    # Update existing auth.json preserving other keys
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
data['OPENAI_API_KEY'] = sys.argv[2]
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\\n')
" "$AUTH_FILE" "$API_KEY"
  else
    printf '{\n  "OPENAI_API_KEY": "%s"\n}\n' "$API_KEY" > "$AUTH_FILE"
  fi
  chmod 600 "$AUTH_FILE"

  ok "Codex 配置完成  (Codex configured)"
}

# ── Configure Claude Code ────────────────────────────────────
configure_claude_code() {
  info "正在配置 Claude Code …  (Configuring Claude Code …)"

  mkdir -p "$CLAUDE_HOME"

  # ── settings.json ──
  local SETTINGS_FILE="$CLAUDE_HOME/settings.json"

  if [ -f "$SETTINGS_FILE" ]; then
    # Merge env keys into existing settings.json
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
env = data.setdefault('env', {})
env['CUMOB_API_KEY'] = sys.argv[2]
env['CUMOB_BASE_URL'] = sys.argv[3]
env['OPENAI_API_KEY'] = sys.argv[2]
env['OPENAI_BASE_URL'] = sys.argv[3]
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\\n')
" "$SETTINGS_FILE" "$API_KEY" "$CUMOB_BASE_URL"
  else
    cat > "$SETTINGS_FILE" << EOF
{
  "env": {
    "CUMOB_API_KEY": "$API_KEY",
    "CUMOB_BASE_URL": "$CUMOB_BASE_URL",
    "OPENAI_API_KEY": "$API_KEY",
    "OPENAI_BASE_URL": "$CUMOB_BASE_URL"
  }
}
EOF
  fi

  ok "Claude Code 配置完成  (Claude Code configured)"
}

# ── Install skill into Codex ─────────────────────────────────
install_skill_codex() {
  info "正在将 cumob-media-generation Skill 安装到 Codex …"

  # Codex skills are typically in ~/.codex/skills/ or a project directory.
  # We symlink for easy updates.
  local SKILL_TARGET="$CODEX_HOME/skills/cumob-media-generation"
  mkdir -p "$CODEX_HOME/skills"

  if [ -L "$SKILL_TARGET" ]; then
    rm "$SKILL_TARGET"
  elif [ -d "$SKILL_TARGET" ]; then
    warn "已存在 $SKILL_TARGET 目录，将备份为 .bak"
    mv "$SKILL_TARGET" "${SKILL_TARGET}.bak.$(date +%s)"
  fi

  ln -s "$SKILL_DIR" "$SKILL_TARGET"
  ok "Skill 已链接到 $SKILL_TARGET"
}

# ── Install skill into Claude Code ───────────────────────────
install_skill_claude_code() {
  info "正在将 cumob-media-generation Skill 安装到 Claude Code …"

  # Method 1: Try `claude plugin install` if CLI is available
  if command -v claude &>/dev/null; then
    info "检测到 claude CLI，尝试使用 claude plugin install …"
    if claude plugin install "$SKILL_DIR" 2>/dev/null; then
      ok "Skill 已通过 claude plugin install 安装"
      return
    else
      warn "claude plugin install 失败，回退到手动安装 …"
    fi
  fi

  # Method 2: Manual symlink into ~/.claude/skills/
  local SKILL_TARGET="$CLAUDE_HOME/skills/cumob-media-generation"
  mkdir -p "$CLAUDE_HOME/skills"

  if [ -L "$SKILL_TARGET" ]; then
    rm "$SKILL_TARGET"
  elif [ -d "$SKILL_TARGET" ]; then
    warn "已存在 $SKILL_TARGET 目录，将备份为 .bak"
    mv "$SKILL_TARGET" "${SKILL_TARGET}.bak.$(date +%s)"
  fi

  ln -s "$SKILL_DIR" "$SKILL_TARGET"
  ok "Skill 已链接到 $SKILL_TARGET"

  # Method 3: Also install as a global custom command for discoverability
  local CMD_DIR="$CLAUDE_HOME/commands"
  mkdir -p "$CMD_DIR"
  cat > "$CMD_DIR/cumob-media.md" << 'CMDEOF'
Use the cumob-media-generation skill for image and video generation.

For images:
```bash
node ~/.claude/skills/cumob-media-generation/scripts/generate-image.mjs --prompt "$ARGUMENTS" --out outputs/generated.png
```

For videos:
```bash
node ~/.claude/skills/cumob-media-generation/scripts/generate-video.mjs --prompt "$ARGUMENTS" --duration 10 --aspect-ratio 16:9 --out outputs/generated.mp4
```

Read the SKILL.md at ~/.claude/skills/cumob-media-generation/SKILL.md for full usage instructions before generating.
CMDEOF
  ok "已创建 Claude Code 命令 /cumob-media"
}

# ── Verify installation ──────────────────────────────────────
verify_installation() {
  local target="$1"
  local success=true

  echo ""
  info "正在验证 $target 安装 …  (Verifying $target installation …)"

  if [ "$target" = "codex" ]; then
    # Check config.toml
    if [ -f "$CODEX_HOME/config.toml" ] && grep -q 'cumob' "$CODEX_HOME/config.toml"; then
      ok "Codex config.toml ✓"
    else
      err "Codex config.toml ✗"; success=false
    fi
    # Check auth.json
    if [ -f "$CODEX_HOME/auth.json" ]; then
      ok "Codex auth.json ✓"
    else
      err "Codex auth.json ✗"; success=false
    fi
    # Check skill
    if [ -d "$CODEX_HOME/skills/cumob-media-generation" ]; then
      ok "Codex Skill 目录 ✓"
    else
      err "Codex Skill 目录 ✗"; success=false
    fi
  fi

  if [ "$target" = "claude-code" ]; then
    # Check settings.json
    if [ -f "$CLAUDE_HOME/settings.json" ]; then
      ok "Claude Code settings.json ✓"
    else
      err "Claude Code settings.json ✗"; success=false
    fi
    # Check skill
    if [ -d "$CLAUDE_HOME/skills/cumob-media-generation" ]; then
      ok "Claude Code Skill 目录 ✓"
    else
      err "Claude Code Skill 目录 ✗"; success=false
    fi
  fi

  # Dry-run test
  if [ -f "$SKILL_DIR/scripts/generate-image.mjs" ]; then
    local dry_run_args=("--prompt" "installation-test" "--out" "/dev/null" "--dry-run" "--no-progress")
    if [ "$target" = "codex" ]; then
      dry_run_args+=("--codex-home" "$CODEX_HOME")
    fi
    if node "$SKILL_DIR/scripts/generate-image.mjs" "${dry_run_args[@]}" &>/dev/null; then
      ok "Dry-run 测试 ✓"
    else
      warn "Dry-run 测试未通过（可能需要先设置环境变量）"
    fi
  fi

  if $success; then
    ok "$target 安装验证通过  ($target installation verified)"
  else
    warn "$target 安装存在问题，请检查上方输出  (Issues found, check output above)"
  fi
}

# ── Summary ──────────────────────────────────────────────────
print_summary() {
  echo ""
  printf "${BOLD}╔══════════════════════════════════════════════╗${NC}\n"
  printf "${BOLD}║            安装完成 / Install Complete        ║${NC}\n"
  printf "${BOLD}╚══════════════════════════════════════════════╝${NC}\n"
  echo ""

  for target in "${TARGETS[@]}"; do
    if [ "$target" = "codex" ]; then
      echo "  📦 Codex:"
      echo "     配置: $CODEX_HOME/config.toml"
      echo "     认证: $CODEX_HOME/auth.json"
      echo "     Skill: $CODEX_HOME/skills/cumob-media-generation"
      echo ""
    fi
    if [ "$target" = "claude-code" ]; then
      echo "  📦 Claude Code:"
      echo "     配置: $CLAUDE_HOME/settings.json"
      echo "     Skill: $CLAUDE_HOME/skills/cumob-media-generation"
      echo "     命令: /cumob-media"
      echo ""
    fi
  done

  printf "${BOLD}API 网关 / Gateway:${NC} $CUMOB_BASE_URL\n"
  echo ""

  info "使用方法 / Usage:"
  echo ""
  echo "  生图 / Generate image:"
  echo "    \"生成一张 1024x1024 的猫咪图片\""
  echo ""
  echo "  生视频 / Generate video:"
  echo "    \"生成一段 10 秒的猫在草地奔跑的视频\""
  echo ""
  info "所有请求将通过 CUMOB 网关 ($CUMOB_BASE_URL) 处理。"
  info "All requests will be routed through the CUMOB gateway."
  echo ""
}

# ── Uninstall support ────────────────────────────────────────
uninstall() {
  echo ""
  printf "${BOLD}CUMOB Uninstaller${NC}\n"
  echo ""

  # Codex
  if [ -L "$CODEX_HOME/skills/cumob-media-generation" ] || [ -d "$CODEX_HOME/skills/cumob-media-generation" ]; then
    rm -rf "$CODEX_HOME/skills/cumob-media-generation"
    ok "已移除 Codex skill"
  fi

  # Claude Code
  if [ -L "$CLAUDE_HOME/skills/cumob-media-generation" ] || [ -d "$CLAUDE_HOME/skills/cumob-media-generation" ]; then
    rm -rf "$CLAUDE_HOME/skills/cumob-media-generation"
    ok "已移除 Claude Code skill"
  fi
  if [ -f "$CLAUDE_HOME/commands/cumob-media.md" ]; then
    rm -f "$CLAUDE_HOME/commands/cumob-media.md"
    ok "已移除 Claude Code 命令 /cumob-media"
  fi

  info "配置文件未移除，如需清理请手动编辑:"
  echo "  Codex:       $CODEX_HOME/config.toml"
  echo "  Claude Code: $CLAUDE_HOME/settings.json"
  echo ""
}

# ── Main ─────────────────────────────────────────────────────
main() {
  # Handle --uninstall flag
  if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    exit 0
  fi

  # Check Node.js
  if ! command -v node &>/dev/null; then
    die "需要 Node.js 18+，请先安装  (Node.js 18+ required)"
  fi
  local node_major
  node_major=$(node -e 'console.log(process.versions.node.split(".")[0])')
  if [ "$node_major" -lt 18 ]; then
    die "需要 Node.js 18+，当前版本: $(node --version)  (Node.js 18+ required, current: $(node --version))"
  fi
  ok "Node.js $(node --version) ✓"

  # Check python3 for JSON manipulation
  if ! command -v python3 &>/dev/null; then
    die "需要 python3（用于配置文件处理）(python3 required for config manipulation)"
  fi

  # Select platform
  select_platform

  # Collect API key
  collect_api_key

  echo ""

  # Configure and install for each target
  for target in "${TARGETS[@]}"; do
    if [ "$target" = "codex" ]; then
      configure_codex
      install_skill_codex
      verify_installation codex
    fi
    if [ "$target" = "claude-code" ]; then
      configure_claude_code
      install_skill_claude_code
      verify_installation claude-code
    fi
  done

  print_summary
}

main "$@"
