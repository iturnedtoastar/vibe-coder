<#
  Vibe Coder — install the optional tools.

  Every step prints the command before running it, so you can see exactly what
  is happening and repeat it yourself. Steps are independent: one failure does
  not stop the rest, and anything already installed is skipped.

  Usage:
    ./scripts/setup.ps1              # everything
    ./scripts/setup.ps1 -SkipWhisper # skip the multi-GB PyTorch download
    ./scripts/setup.ps1 -WhatIf      # print the commands, install nothing
#>

[CmdletBinding()]
param(
  [switch]$SkipWhisper,
  [switch]$SkipAgents,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Continue'
$results = @()

function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Step {
  param([string]$Name, [string]$Command, [scriptblock]$Check)

  if ($Check -and (& $Check)) {
    Write-Host "  [skip] $Name already installed" -ForegroundColor DarkGray
    $script:results += [pscustomobject]@{ Tool = $Name; Result = 'already installed' }
    return
  }

  Write-Host ""
  Write-Host "  $Name" -ForegroundColor White
  Write-Host "  > $Command" -ForegroundColor DarkCyan

  if ($WhatIf) {
    $script:results += [pscustomobject]@{ Tool = $Name; Result = 'dry run' }
    return
  }

  try {
    Invoke-Expression $Command 2>&1 | Out-Null
    $ok = if ($Check) { & $Check } else { $true }
    $script:results += [pscustomobject]@{ Tool = $Name; Result = $(if ($ok) { 'installed' } else { 'ran, not detected' }) }
  } catch {
    $script:results += [pscustomobject]@{ Tool = $Name; Result = "failed: $($_.Exception.Message)" }
  }
}

Write-Host ""
Write-Host "  Vibe Coder setup" -ForegroundColor White
Write-Host "  ----------------" -ForegroundColor DarkGray

if (-not (Have winget)) {
  Write-Host "  winget is required. Install 'App Installer' from the Microsoft Store." -ForegroundColor Yellow
  return
}

$wingetArgs = '--accept-package-agreements --accept-source-agreements --silent'

Step 'ffmpeg'  "winget install --id Gyan.FFmpeg.Essentials $wingetArgs" { Have ffmpeg }
Step 'Node.js' "winget install --id OpenJS.NodeJS $wingetArgs"          { Have node }
Step 'yt-dlp'  "winget install --id yt-dlp.yt-dlp $wingetArgs"          { Have yt-dlp }
Step 'Ollama'  "winget install --id Ollama.Ollama $wingetArgs"          { Have ollama }

if (Have npm) {
  Step 'HyperFrames' 'npm install -g hyperframes' { Have hyperframes }
  if (-not $SkipAgents) {
    Step 'Claude Code' 'npm install -g @anthropic-ai/claude-code' { Have claude }
    Step 'Codex'       'npm install -g @openai/codex'             { Have codex }
    Step 'Vercel CLI'  'npm install -g vercel'                    { Have vercel }
  }
} else {
  Write-Host "  npm not found - skipping Node tools. Re-run after installing Node." -ForegroundColor Yellow
}

if ((Have pip) -and -not $SkipWhisper) {
  Write-Host ""
  Write-Host "  Whisper pulls PyTorch - several GB, this takes a while." -ForegroundColor Yellow
  Step 'Whisper' 'pip install -U openai-whisper' { Have whisper }
}

if (Have git) {
  $skill = Join-Path $env:USERPROFILE '.claude\skills\video-use'
  Step 'video-use skill' "git clone --depth 1 https://github.com/browser-use/video-use.git `"$skill`"" { Test-Path $skill }
  if ((Have pip) -and (Test-Path $skill)) {
    Step 'video-use deps' 'pip install requests librosa matplotlib pillow numpy' { $true }
  }
}

# pip's per-user Scripts directory is frequently missing from PATH, which leaves
# console scripts installed but undiscoverable.
if (-not $WhatIf) {
  $pyScripts = Get-ChildItem "$env:APPDATA\Python" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'Scripts' } | Where-Object { Test-Path $_ }

  foreach ($dir in $pyScripts) {
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($user -split ';' -notcontains $dir) {
      Write-Host ""
      Write-Host "  Adding to your PATH: $dir" -ForegroundColor DarkCyan
      [Environment]::SetEnvironmentVariable('Path', $user.TrimEnd(';') + ';' + $dir, 'User')
      $env:Path += ";$dir"
    }
  }
}

if ((Have ollama) -and -not $WhatIf) {
  Write-Host ""
  Write-Host "  Pull a local coding model with:" -ForegroundColor White
  Write-Host "  > ollama pull qwen2.5-coder" -ForegroundColor DarkCyan
}

Write-Host ""
Write-Host "  Summary" -ForegroundColor White
$results | Format-Table -AutoSize

Write-Host "  Sign in to the keyless agents from the Workspace Terminal:" -ForegroundColor White
Write-Host "  > claude     > agy     > codex" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Restart Vibe Coder so it picks up the new PATH." -ForegroundColor Yellow
Write-Host ""
