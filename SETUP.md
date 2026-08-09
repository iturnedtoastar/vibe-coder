# Vibe Coder — full setup

Vibe Coder runs with nothing installed. Every optional tool below unlocks a
feature, and the app detects each one at launch: if a tool is missing the
related button tells you so instead of failing.

**Fastest path — hand this file to an AI agent** (Claude Code, Antigravity,
Codex) with:

> Read SETUP.md in this folder and install everything for me.

Or run the script beside this file:

```powershell
# Windows (PowerShell)
./scripts/setup.ps1
```

```bash
# macOS / Linux
bash ./scripts/setup.sh
```

---

## What each tool unlocks

| Tool | Unlocks | Required? |
|---|---|---|
| **ffmpeg** | Video rendering, dictation audio conversion | For video/voice |
| **Node.js 22+** | HyperFrames video rendering | For video |
| **openai-whisper** | 🎙 Dictate prompts to the agent, fully offline | Optional |
| **HyperFrames** | 🎬 Render your HTML page to MP4 | Optional |
| **yt-dlp** | `download_media` agent tool | Optional |
| **Ollama** | Local models — no API key, nothing leaves your PC | Optional |
| **Claude Code** | Claude Code terminal tab + keyless agent provider | Recommended |
| **Antigravity** | Keyless agent provider | Optional |
| **Codex** | Keyless agent provider | Optional |
| **video-use** | Conversational video editing in the Claude Code tab | Optional |
| **Vercel CLI** | Deploy your project live, and link it to GitHub | Optional |

Nothing here is required to write code, use the terminal, or use an API key.

---

## Windows

```powershell
# Core media + runtime
winget install --id Gyan.FFmpeg.Essentials --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements   # needs 22+
winget install --id yt-dlp.yt-dlp --accept-package-agreements --accept-source-agreements
winget install --id Ollama.Ollama --accept-package-agreements --accept-source-agreements

# Video rendering from HTML
npm install -g hyperframes

# Dictation (downloads PyTorch, several GB)
pip install -U openai-whisper

# Agent CLIs — each signs in through its own terminal login, no API key
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex

# Conversational video editing, as a Claude Code skill
git clone --depth 1 https://github.com/browser-use/video-use.git "$env:USERPROFILE\.claude\skills\video-use"
pip install requests librosa matplotlib pillow numpy

# Deploy to the web
npm install -g vercel
vercel login          # opens a browser; the agent can deploy once you're signed in

# A local model to actually run
ollama pull qwen2.5-coder
```

### Windows PATH gotcha

`pip` installs console scripts into a per-user `Scripts` directory that is
often **not on PATH**, so a tool can be installed yet undiscoverable. Add it:

```powershell
$scripts = "$env:APPDATA\Python\Python314\Scripts"   # match your Python version
$user = [Environment]::GetEnvironmentVariable('Path','User')
if ($user -split ';' -notcontains $scripts) {
  [Environment]::SetEnvironmentVariable('Path', $user.TrimEnd(';') + ';' + $scripts, 'User')
}
```

Then **restart Vibe Coder** — Windows only gives the new PATH to newly launched
processes.

---

## macOS

```bash
brew install ffmpeg node yt-dlp ollama
npm install -g hyperframes @anthropic-ai/claude-code @openai/codex vercel
pip3 install -U openai-whisper
git clone --depth 1 https://github.com/browser-use/video-use.git ~/.claude/skills/video-use
pip3 install requests librosa matplotlib pillow numpy
ollama pull qwen2.5-coder
```

## Linux (Debian/Ubuntu)

```bash
sudo apt update && sudo apt install -y ffmpeg python3-pip git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
curl -fsSL https://ollama.com/install.sh | sh
pip3 install -U openai-whisper yt-dlp
npm install -g hyperframes @anthropic-ai/claude-code @openai/codex
git clone --depth 1 https://github.com/browser-use/video-use.git ~/.claude/skills/video-use
pip3 install requests librosa matplotlib pillow numpy
ollama pull qwen2.5-coder
```

---

## Signing in (no API keys needed)

Open **Workspace Terminal** in the app and run each once:

```
claude       # Claude Code — sign in with your Anthropic account
agy          # Antigravity — sign in with your Google account
codex        # Codex — sign in with your OpenAI account
```

Then pick that provider under **Settings → AI Configuration**. They authenticate
through the terminal session, so no key is stored in the app.

If you would rather use API keys, paste one into Settings, or put it in
`server/.env` (see `server/.env.example`) so it never touches the browser.

---

## Verifying

Relaunch Vibe Coder and check the console panel at the bottom, or run:

```powershell
foreach ($c in 'ffmpeg','node','whisper','hyperframes','yt-dlp','ollama','claude','agy','codex') {
  $p = Get-Command $c -ErrorAction SilentlyContinue
  "{0,-14} {1}" -f $c, $(if ($p) { $p.Source } else { 'MISSING' })
}
```

In the app itself:

- **Settings → AI Configuration** — the status line reads *Connected*,
  *No API key*, or *&lt;tool&gt; not installed* for the selected provider.
- **🎙 mic button** in the agent panel — active once Whisper is installed.
- **Video button** in the toolbar — active once HyperFrames + Node 22+ are present.
- **Claude Code tab** — launches the CLI automatically when it's installed.

---

## Notes

- Everything above is optional and locally installed. Ollama and Whisper never
  send data off your machine.
- `openai-whisper` pulls PyTorch — expect several GB and a long download.
- HyperFrames needs **Node 22+**. The app bundles Node 20 internally, so it
  deliberately runs HyperFrames on your *system* Node.
- yt-dlp changes often; `yt-dlp -U` updates it.
