param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("status", "open", "play", "pause", "resume", "stop", "next", "previous")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Write-BridgeResult([hashtable]$Value) {
  Write-Output ($Value | ConvertTo-Json -Depth 6 -Compress)
}

function Find-QQMusicExecutable {
  $registryKeys = @(
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Tencent\QQMusic",
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Tencent\QQMusic",
    "Registry::HKEY_CURRENT_USER\SOFTWARE\Tencent\QQMusic"
  )
  foreach ($key in $registryKeys) {
    try {
      $install = [string](Get-ItemProperty -LiteralPath $key -ErrorAction Stop).Install
      if ($install) {
        $candidate = Join-Path $install "QQMusic.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      }
    } catch { }
  }
  return $null
}

function Await-WinRt($Operation, [type]$ResultType, [int]$TimeoutMs = 5000) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  if (-not $method) { throw "Windows Runtime AsTask bridge unavailable" }
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait($TimeoutMs)) { throw "Windows media control timed out" }
  return $task.Result
}

function New-MediaManager {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] > $null
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] > $null
  return Await-WinRt (
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
  ) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Find-QQMusicSession($Manager) {
  return @($Manager.GetSessions()) |
    Where-Object { [string]$_.SourceAppUserModelId -match "(?i)(^|[.\\])QQMusic(?:\.exe)?$" } |
    Select-Object -First 1
}

function Session-State($Session, [string]$Executable) {
  $installed = [bool]$Executable
  $running = [bool](Get-Process -Name "QQMusic" -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $Session) {
    return [ordered]@{
      ok = $true
      provider = "qqmusic"
      installed = $installed
      running = $running
      connected = $false
      loaded = $false
      paused = $true
      playbackStatus = "unavailable"
      positionMs = 0
      durationMs = 0
      currentTrackId = $null
      currentTrack = $null
      capabilities = @("status", "open")
      reason = if ($installed) { "QQ 音乐尚未建立 Windows 媒体会话；请先在客户端选择一首歌。" } else { "未检测到 QQ 音乐客户端。" }
    }
  }

  $playback = $Session.GetPlaybackInfo()
  $statusCode = [int]$playback.PlaybackStatus
  $statusNames = @("closed", "opened", "changing", "stopped", "playing", "paused")
  $status = if ($statusCode -ge 0 -and $statusCode -lt $statusNames.Count) { $statusNames[$statusCode] } else { "unknown" }
  $media = Await-WinRt (
    $Session.TryGetMediaPropertiesAsync()
  ) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $timeline = $Session.GetTimelineProperties()
  $title = [string]$media.Title
  $track = if ($title) {
    [ordered]@{
      id = "qqmusic:current"
      title = $title
      artist = [string]$media.Artist
      album = [string]$media.AlbumTitle
      durationMs = [math]::Max(0, [math]::Round($timeline.EndTime.TotalMilliseconds))
    }
  } else { $null }

  return [ordered]@{
    ok = $true
    provider = "qqmusic"
    installed = $installed
    running = $running
    connected = $true
    loaded = [bool]$title
    paused = $statusCode -ne 4
    playbackStatus = $status
    positionMs = [math]::Max(0, [math]::Round($timeline.Position.TotalMilliseconds))
    durationMs = [math]::Max(0, [math]::Round($timeline.EndTime.TotalMilliseconds))
    currentTrackId = if ($title) { "qqmusic:current" } else { $null }
    currentTrack = $track
    capabilities = @("status", "open", "play", "pause", "resume", "stop", "next", "previous")
    reason = $null
  }
}

try {
  if ($env:OS -ne "Windows_NT") { throw "QQ 音乐 Provider 只支持 Windows Electron 客户端" }
  $executable = Find-QQMusicExecutable
  if ($Action -eq "open") {
    if (-not $executable) { throw "未检测到 QQ 音乐客户端" }
    Start-Process -FilePath $executable
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    do {
      Start-Sleep -Milliseconds 350
      $manager = New-MediaManager
      $session = Find-QQMusicSession $manager
    } while (-not $session -and [DateTime]::UtcNow -lt $deadline)
    $state = Session-State $session $executable
    $state.opened = $true
    Write-BridgeResult $state
    exit 0
  }

  $manager = New-MediaManager
  $session = Find-QQMusicSession $manager
  if ($Action -eq "status") {
    Write-BridgeResult (Session-State $session $executable)
    exit 0
  }
  if (-not $session) { throw "QQ 音乐没有可控制的媒体会话；请先打开客户端并选择一首歌" }

  $operation = switch ($Action) {
    "play" { $session.TryPlayAsync() }
    "resume" { $session.TryPlayAsync() }
    "pause" { $session.TryPauseAsync() }
    "stop" { $session.TryStopAsync() }
    "next" { $session.TrySkipNextAsync() }
    "previous" { $session.TrySkipPreviousAsync() }
  }
  $accepted = Await-WinRt $operation ([bool])
  if (-not $accepted) { throw "QQ 音乐拒绝了 $Action 控制请求" }
  Start-Sleep -Milliseconds 180
  $state = Session-State $session $executable
  $state.action = $Action
  $state.accepted = $true
  Write-BridgeResult $state
} catch {
  Write-BridgeResult ([ordered]@{
    ok = $false
    provider = "qqmusic"
    action = $Action
    error = $_.Exception.Message
  })
  exit 1
}
