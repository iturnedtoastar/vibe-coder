#!/usr/bin/env bash
# Vibe Coder — install the optional tools (macOS / Linux).
#
# Every step prints the command before running it. Steps are independent: one
# failure does not stop the rest, and anything already present is skipped.
#
#   bash scripts/setup.sh              # everything
#   bash scripts/setup.sh --skip-whisper
#   bash scripts/setup.sh --dry-run

set -u

DRY_RUN=0
SKIP_WHISPER=0
SKIP_AGENTS=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-whisper) SKIP_WHISPER=1 ;;
    --skip-agents) SKIP_AGENTS=1 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
SUMMARY=""

step() {                       # step <name> <check-cmd> <install-cmd>
  local name="$1" check="$2" cmd="$3"
  if have "$check"; then
    printf '  [skip] %s already installed\n' "$name"
    SUMMARY+="  $name: already installed\n"
    return
  fi
  printf '\n  %s\n  > %s\n' "$name" "$cmd"
  if [ "$DRY_RUN" = "1" ]; then SUMMARY+="  $name: dry run\n"; return; fi
  if eval "$cmd" >/dev/null 2>&1 && have "$check"; then
    SUMMARY+="  $name: installed\n"
  else
    SUMMARY+="  $name: FAILED (run the command above to see why)\n"
  fi
}

printf '\n  Vibe Coder setup\n  ----------------\n'

if [[ "$OSTYPE" == darwin* ]]; then
  if ! have brew; then
    echo "  Homebrew is required: https://brew.sh" >&2
    exit 1
  fi
  step 'ffmpeg' ffmpeg 'brew install ffmpeg'
  step 'Node.js' node  'brew install node'
  step 'yt-dlp' yt-dlp 'brew install yt-dlp'
  step 'Ollama' ollama 'brew install ollama'
else
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  step 'ffmpeg' ffmpeg "$SUDO apt-get update && $SUDO apt-get install -y ffmpeg"
  step 'git'    git    "$SUDO apt-get install -y git"
  step 'pip'    pip3   "$SUDO apt-get install -y python3-pip"
  step 'Node.js' node  "curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - && $SUDO apt-get install -y nodejs"
  step 'Ollama' ollama 'curl -fsSL https://ollama.com/install.sh | sh'
  step 'yt-dlp' yt-dlp 'pip3 install -U yt-dlp'
fi

if have npm; then
  step 'HyperFrames' hyperframes 'npm install -g hyperframes'
  if [ "$SKIP_AGENTS" = "0" ]; then
    step 'Claude Code' claude 'npm install -g @anthropic-ai/claude-code'
    step 'Codex'       codex  'npm install -g @openai/codex'
    step 'Vercel CLI'  vercel 'npm install -g vercel'
  fi
else
  echo "  npm not found - skipping Node tools." >&2
fi

if have pip3 && [ "$SKIP_WHISPER" = "0" ]; then
  printf '\n  Whisper pulls PyTorch - several GB, this takes a while.\n'
  step 'Whisper' whisper 'pip3 install -U openai-whisper'
fi

SKILL="$HOME/.claude/skills/video-use"
if have git && [ ! -d "$SKILL" ]; then
  printf '\n  video-use skill\n  > git clone --depth 1 https://github.com/browser-use/video-use.git %s\n' "$SKILL"
  if [ "$DRY_RUN" = "0" ]; then
    mkdir -p "$HOME/.claude/skills"
    if git clone --depth 1 https://github.com/browser-use/video-use.git "$SKILL" >/dev/null 2>&1; then
      SUMMARY+="  video-use: installed\n"
      have pip3 && pip3 install requests librosa matplotlib pillow numpy >/dev/null 2>&1
    else
      SUMMARY+="  video-use: FAILED\n"
    fi
  fi
elif [ -d "$SKILL" ]; then
  SUMMARY+="  video-use: already installed\n"
fi

printf '\n  Summary\n'
printf '%b' "$SUMMARY"

if have ollama; then
  printf '\n  Pull a local coding model with:\n  > ollama pull qwen2.5-coder\n'
fi

printf '\n  Sign in to the keyless agents from the Workspace Terminal:\n'
printf '  > claude     > agy     > codex\n'
printf '\n  Restart Vibe Coder so it picks up the new PATH.\n\n'
