---
name: vibe-coder-setup
description: Install and verify everything Vibe Coder needs — ffmpeg, Node 22+, Whisper, HyperFrames, yt-dlp, Ollama, and the agent CLIs (Claude Code, Antigravity, Codex) plus the video-use skill. Use when setting up Vibe Coder on a new machine, when a feature reports a tool is missing, or when the user asks to install what the app needs.
---

# Setting up Vibe Coder

Vibe Coder works with nothing installed. Each tool below unlocks one feature,
and the app detects every one of them at launch — a missing tool produces a
clear message, never a silent failure.

## How to run it

Prefer the script; it prints each command before running it, skips what's
already present, and continues past failures.

```powershell
./scripts/setup.ps1                 # Windows
```
```bash
bash ./scripts/setup.sh             # macOS / Linux
```

Show the user each command as you go — they want to learn what's happening, not
just have it done.

## What to install, and why

| Tool | Unlocks | Install |
|---|---|---|
| ffmpeg | video render + dictation audio | `winget install Gyan.FFmpeg.Essentials` / `brew install ffmpeg` |
| Node 22+ | HyperFrames | `winget install OpenJS.NodeJS` / `brew install node` |
| openai-whisper | dictate prompts, offline | `pip install -U openai-whisper` |
| HyperFrames | render HTML page to MP4 | `npm i -g hyperframes` |
| yt-dlp | `download_media` agent tool | `winget install yt-dlp.yt-dlp` |
| Ollama | local models, no API key | `winget install Ollama.Ollama` then `ollama pull qwen2.5-coder` |
| Claude Code | Claude Code tab + keyless provider | `npm i -g @anthropic-ai/claude-code` |
| Codex | keyless provider | `npm i -g @openai/codex` |
| Antigravity | keyless provider | download from antigravity.google |
| video-use | conversational video editing | `git clone --depth 1 https://github.com/browser-use/video-use.git ~/.claude/skills/video-use` |

## Three things that go wrong

**pip scripts off PATH.** On Windows `pip` installs console scripts into
`%APPDATA%\Python\Python3XX\Scripts`, which is often not on PATH — the tool is
installed but permanently undiscoverable. Add that directory to the *user* PATH
and tell the user to restart the app; Windows only hands the new environment to
newly launched processes.

**npm's extensionless shim.** `npm i -g` writes `foo`, `foo.cmd` and `foo.ps1`
side by side. The extensionless one comes first in PATH order and is a bash
script that Windows cannot execute. When resolving a binary, prefer
`.exe → .cmd → .bat`.

**Whisper is large.** It pulls PyTorch — several GB. Say so before starting it
rather than letting it look hung, and run it in the background.

## Verifying

```powershell
foreach ($c in 'ffmpeg','node','whisper','hyperframes','yt-dlp','ollama','claude','agy','codex') {
  $p = Get-Command $c -ErrorAction SilentlyContinue
  "{0,-14} {1}" -f $c, $(if ($p) { $p.Source } else { 'MISSING' })
}
```

Then relaunch Vibe Coder and confirm in the app:

- **Settings → AI Configuration** — status reads *Connected* for the chosen provider
- **mic button** in the agent panel — enabled once Whisper is present
- **Video button** in the toolbar — enabled once HyperFrames + Node 22+ are present
- **Claude Code tab** — auto-launches the CLI when installed

## Signing in

The keyless providers authenticate through their own terminal login. From the
app's Workspace Terminal, run each once and follow the prompts:

```
claude      agy      codex
```

No API key is stored in the app. If the user prefers keys, they go in
Settings → AI Configuration, or in `server/.env` to keep them off the page.
