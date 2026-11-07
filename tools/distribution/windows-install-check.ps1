# Real Windows installer acceptance for a built Audivane NSIS package.
# Run on an interactive Windows x64 runner/VM as the target user (never elevated).
# It installs per-user, verifies files/registry, runs the packaged Playwright
# acceptance, optionally proves a locked uninstall fails, then uninstalls.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$TestLockedUninstall
)

$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Audivane"
$exe = Join-Path $installDir "Audivane.exe"
$uninstaller = Join-Path $installDir "Uninstall.exe"
$marker = Join-Path $installDir ".audivane-install"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Audivane"
$installed = $false

function Assert-Condition([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

function Invoke-Uninstaller([string]$path) {
  $process = Start-Process -FilePath $path -ArgumentList "/S" -Wait -PassThru
  Start-Sleep -Seconds 2
  return $process.ExitCode
}

try {
  Assert-Condition (Test-Path -LiteralPath $Installer -PathType Leaf) "Installer not found: $Installer"
  Assert-Condition (-not (Test-Path -LiteralPath $installDir)) "Refusing to test over an existing $installDir; run on a clean user profile"

  Write-Host "[windows-check] installing $Installer per-user"
  $install = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
  $installed = $true
  Assert-Condition ($install.ExitCode -eq 0) "Installer exited $($install.ExitCode)"
  Assert-Condition (Test-Path -LiteralPath $exe -PathType Leaf) "Installed executable is missing"
  Assert-Condition (Test-Path -LiteralPath $marker -PathType Leaf) "Ownership marker is missing"
  Assert-Condition ((Get-Content -LiteralPath $marker -Raw).Trim() -eq "Audivane") "Ownership marker content is wrong"
  Assert-Condition (Test-Path -LiteralPath (Join-Path $installDir "resources\distribution.json")) "Packaged distribution metadata is missing"
  Assert-Condition (Test-Path -LiteralPath (Join-Path $installDir "resources\native-bundle-manifest.json")) "Native bundle manifest is missing"
  foreach ($relative in @(
    "resources\process-host\audivane-process-host.exe",
    "resources\third_party\ffmpeg\bin\ffmpeg.exe",
    "resources\third_party\ffmpeg\bin\ffprobe.exe",
    "resources\third_party\ldac\bin\ldac_helper.exe"
  )) {
    Assert-Condition (Test-Path -LiteralPath (Join-Path $installDir $relative)) "Installed native tool is missing: $relative"
  }
  $distribution = Get-Content -LiteralPath (Join-Path $installDir "resources\distribution.json") -Raw | ConvertFrom-Json
  $workspace = Get-Content -LiteralPath (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
  Assert-Condition ($distribution.version -eq $workspace.version) "Installed version disagrees with the workspace"
  Assert-Condition ($distribution.platform -eq "win32") "Installed package is not a Windows build"
  Assert-Condition ($distribution.executable -eq "Audivane.exe") "Installed executable metadata is wrong"
  Assert-Condition ($distribution.browserCodecAssets -eq "excluded-native-only") "Browser codec exclusion is not recorded"
  Assert-Condition ($null -ne $distribution.processHost) "Process lifetime host metadata is missing"
  Assert-Condition ($distribution.processHost.path -eq "process-host/audivane-process-host.exe") "Process lifetime host metadata path is wrong"
  $processHost = Join-Path $installDir "resources\process-host\audivane-process-host.exe"
  Assert-Condition ((Get-Item -LiteralPath $processHost).Length -eq $distribution.processHost.bytes) "Process lifetime host size disagrees with metadata"
  Assert-Condition ((Get-FileHash -LiteralPath $processHost -Algorithm SHA256).Hash.ToLower() -eq $distribution.processHost.sha256) "Process lifetime host hash disagrees with metadata"

  $keys = Get-ItemProperty -LiteralPath $uninstallKey
  Assert-Condition ($keys.DisplayName -eq "Audivane") "Uninstall entry is missing"
  Assert-Condition ($keys.UninstallString -match '^".*\\Uninstall\.exe"$') "UninstallString is not quoted for paths with spaces"
  Assert-Condition ($keys.QuietUninstallString -match '^".*\\Uninstall\.exe" /S$') "QuietUninstallString is not quoted for paths with spaces"
  Assert-Condition ($keys.InstallLocation -match '^".*"$') "InstallLocation is not quoted"

  Write-Host "[windows-check] running packaged Playwright acceptance against $exe"
  $env:CODEC_ABX_PACKAGED_EXECUTABLE = $exe
  Push-Location $RepoRoot
  try {
    & npm run test:desktop -- package.electron.ts
    if ($LASTEXITCODE -ne 0) { throw "Packaged Playwright acceptance exited $LASTEXITCODE" }
  } finally {
    Pop-Location
    Remove-Item Env:\CODEC_ABX_PACKAGED_EXECUTABLE -ErrorAction SilentlyContinue
  }

  # Kill only the main process. The whole-desktop guard must then close the
  # kill-on-close Job Object and reap every Electron/worker/codec descendant.
  Write-Host "[windows-check] proving early main-process death leaves no descendants"
  $app = Start-Process -FilePath $exe -PassThru
  try {
    Start-Sleep -Seconds 8
    $guard = Get-Process -Name "audivane-process-host" -ErrorAction SilentlyContinue
    Assert-Condition ($null -ne $guard) "The whole-desktop process lifetime guard was not running"
    & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $app.Id /F | Out-Null
    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 250
      $survivors = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        try {
          if ($_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)) { $_ }
        } catch { }
      })
    } while ($survivors.Count -gt 0 -and (Get-Date) -lt $deadline)
    Assert-Condition ($survivors.Count -eq 0) ("Processes survived main-process death: " + (($survivors | ForEach-Object { "$($_.Id):$($_.Path)" }) -join ", "))
  } finally {
    if (-not $app.HasExited) {
      & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $app.Id /T /F | Out-Null
    }
  }

  if ($TestLockedUninstall) {
    Write-Host "[windows-check] proving a locked uninstall cannot silently succeed"
    $app = Start-Process -FilePath $exe -PassThru
    try {
      Start-Sleep -Seconds 8
      $code = Invoke-Uninstaller $uninstaller
      Assert-Condition (Test-Path -LiteralPath $installDir) "Uninstaller deleted a running installation (exit $code)"
      Assert-Condition (Test-Path -LiteralPath $marker) "Uninstaller removed ownership metadata after a locked failure"
    } finally {
      if (-not $app.HasExited) {
        # Exact system cleanup helper; no shell/PATH indirection.
        & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $app.Id /T /F | Out-Null
      }
    }
  }

  if (Test-Path -LiteralPath $uninstaller) {
    Write-Host "[windows-check] uninstalling"
    $code = Invoke-Uninstaller $uninstaller
    Assert-Condition ($code -eq 0) "Uninstaller exited $code"
  } else {
    Write-Host "[windows-check] uninstaller was removed by the locked-failure probe; rerunning installer to repair before uninstall"
    $repair = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
    Assert-Condition ($repair.ExitCode -eq 0) "Repair installer exited $($repair.ExitCode)"
    $code = Invoke-Uninstaller $uninstaller
    Assert-Condition ($code -eq 0) "Uninstaller exited $code"
  }
  $installed = $false
  Assert-Condition (-not (Test-Path -LiteralPath $installDir)) "Uninstall left $installDir behind"
  Assert-Condition (-not (Test-Path -LiteralPath $uninstallKey)) "Uninstall left the registry entry behind"
  Write-Host "[windows-check] install, packaged acceptance, locked-uninstall behavior and uninstall passed"
} finally {
  if ($installed -and (Test-Path -LiteralPath $uninstaller)) {
    try { Invoke-Uninstaller $uninstaller | Out-Null } catch { Write-Warning "Cleanup uninstall failed: $_" }
  }
}
