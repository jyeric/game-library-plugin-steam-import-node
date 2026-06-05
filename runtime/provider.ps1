$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
  $scriptPath = $PSCommandPath
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    $scriptPath = $MyInvocation.MyCommand.Path
  }
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    $scriptPath = $MyInvocation.InvocationName
  }
  if (-not [string]::IsNullOrWhiteSpace($scriptPath)) {
    $scriptDir = Split-Path -LiteralPath $scriptPath -Parent
  }
}
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
  $scriptDir = (Get-Location).ProviderPath
}
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
  $scriptDir = "."
}

$logDir = [System.IO.Path]::Combine($scriptDir, "logs")
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = [System.IO.Path]::Combine($logDir, "last-run.log")
$nodeStderrLog = [System.IO.Path]::Combine($logDir, "node-stderr.log")

function Write-PluginLog {
  param([string] $Message)
  Add-Content -Path $logFile -Value $Message -Encoding UTF8
}

Set-Content -Path $logFile -Value "Steam Import Node Provider PowerShell runtime start" -Encoding UTF8
Set-Content -Path $nodeStderrLog -Value "" -Encoding UTF8

$providerPath = [System.IO.Path]::Combine($scriptDir, "provider.mjs")
$bundledNode = [System.IO.Path]::Combine($scriptDir, "node.exe")
$bundledNodeDir = [System.IO.Path]::Combine([System.IO.Path]::Combine($scriptDir, "node"), "node.exe")

Write-PluginLog "script_dir=$scriptDir"
Write-PluginLog "working_dir=$(Get-Location)"
Write-PluginLog "runtime_entry=$providerPath"
Write-PluginLog "bundled_node=$bundledNode"
Write-PluginLog "bundled_node_dir=$bundledNodeDir"
Write-PluginLog "GAME_LIBRARY_NODE=$env:GAME_LIBRARY_NODE"
Write-PluginLog "PATH=$env:PATH"

$nodeExe = $null
if (Test-Path -LiteralPath $bundledNode) {
  $nodeExe = $bundledNode
  Write-PluginLog "node_source=bundled-file"
} elseif (Test-Path -LiteralPath $bundledNodeDir) {
  $nodeExe = $bundledNodeDir
  Write-PluginLog "node_source=bundled-directory"
} elseif ($env:GAME_LIBRARY_NODE -and (Test-Path -LiteralPath $env:GAME_LIBRARY_NODE)) {
  $nodeExe = $env:GAME_LIBRARY_NODE
  Write-PluginLog "node_source=GAME_LIBRARY_NODE"
} else {
  $pathNode = Get-Command node -ErrorAction SilentlyContinue
  if ($pathNode) {
    $nodeExe = $pathNode.Source
    Write-PluginLog "node_source=PATH"
  }
}

if (-not $nodeExe) {
  Write-PluginLog "error=node_not_found"
  [Console]::Error.WriteLine("Node.js was not found for Steam Import Node Provider. See log: $logFile")
  exit 1
}

if (-not (Test-Path -LiteralPath $providerPath)) {
  Write-PluginLog "error=provider_mjs_missing"
  [Console]::Error.WriteLine("Steam Import Node Provider runtime entry was not found: $providerPath")
  [Console]::Error.WriteLine("See log: $logFile")
  exit 1
}

Write-PluginLog "selected_node=$nodeExe"
Write-PluginLog "command=`"$nodeExe`" `"$providerPath`""

$env:STEAM_IMPORT_PLUGIN_LOG = $logFile
$stdinText = [Console]::In.ReadToEnd()
Write-PluginLog "stdin_chars=$($stdinText.Length)"

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodeExe
$startInfo.Arguments = "`"$providerPath`""
$startInfo.WorkingDirectory = $scriptDir
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
[void] $process.Start()
$process.StandardInput.Write($stdinText)
$process.StandardInput.Close()
$stdoutText = $process.StandardOutput.ReadToEnd()
$stderrText = $process.StandardError.ReadToEnd()
$process.WaitForExit()

if ($stdoutText) {
  $stdoutBytes = [System.Text.Encoding]::UTF8.GetBytes($stdoutText)
  [Console]::OpenStandardOutput().Write($stdoutBytes, 0, $stdoutBytes.Length)
}
Set-Content -Path $nodeStderrLog -Value $stderrText -Encoding UTF8

Write-PluginLog "stdout_chars=$($stdoutText.Length)"
Write-PluginLog "stdout_begin"
if ($stdoutText) {
  Add-Content -Path $logFile -Value $stdoutText -Encoding UTF8
}
Write-PluginLog "stdout_end"
Write-PluginLog "node_exit_code=$($process.ExitCode)"
Write-PluginLog "node_stderr_log=$nodeStderrLog"
Write-PluginLog "node_stderr_begin"
if (Test-Path -LiteralPath $nodeStderrLog) {
  Get-Content -Path $nodeStderrLog -Raw | Add-Content -Path $logFile -Encoding UTF8
}
Write-PluginLog "node_stderr_end"

if ($process.ExitCode -ne 0) {
  [Console]::Error.WriteLine("Steam Import Node Provider runtime failed with exit code $($process.ExitCode). See log: $logFile")
}
exit $process.ExitCode
