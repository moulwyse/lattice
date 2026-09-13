[CmdletBinding()]
param(
  [string]$Ref = "main",
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[lattice-install] $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "OK: $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "Error: $Message" -ForegroundColor Red
  exit 1
}

Write-Step "Checking environment prerequisites..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Fail "Node.js is not found. Please install Node.js >= 20.19.0 or >= 22.12.0 from https://nodejs.org"
}

$nodeVersionRaw = (& node -v) -replace '^v', ''
$nodeParts = $nodeVersionRaw.Split('.')
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = [int]$nodeParts[1]

if ($nodeMajor -lt 20 -or ($nodeMajor -eq 20 -and $nodeMinor -lt 19) -or ($nodeMajor -eq 21) -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
  Write-Fail "Node.js version $nodeVersionRaw detected. Lattice requires Node.js ^20.19.0 or >= 22.12.0."
}
Write-Ok "Node.js $nodeVersionRaw"

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  Write-Fail "Git is not found. Please install Git from https://git-scm.com"
}
Write-Ok "Git"

$targetDir = $null
$isLocalRepo = $false
try {
  $invocationPath = $MyInvocation.MyCommand.Path
  if ($invocationPath) {
    $parentDir = Split-Path -Parent (Split-Path -Parent $invocationPath)
    $pkgJsonPath = Join-Path $parentDir "package.json"
    if (Test-Path $pkgJsonPath) {
      $pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
      if ($pkg.name -eq "lattice-v2") {
        $targetDir = $parentDir
        $isLocalRepo = $true
      }
    }
  }
} catch {
  $isLocalRepo = $false
}

if (-not $isLocalRepo) {
  if (-not $InstallDir) {
    $targetDir = Join-Path $env:LOCALAPPDATA "lattice-agent"
  } else {
    $targetDir = $InstallDir
  }

  if (Test-Path (Join-Path $targetDir ".git")) {
    Write-Step "Updating existing installation in $targetDir..."
    & git -C $targetDir fetch --all --tags
    & git -C $targetDir checkout $Ref
    & git -C $targetDir pull origin $Ref
  } else {
    Write-Step "Cloning Lattice into $targetDir..."
    if (Test-Path $targetDir) {
      Remove-Item -Recurse -Force $targetDir
    }
    & git clone --branch $Ref --depth 1 "https://github.com/moulwyse/lattice.git" $targetDir
  }
} else {
  Write-Step "Using current repository checkout: $targetDir"
}

Write-Step "Installing dependencies and compiling TypeScript..."
Push-Location $targetDir
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) {
    & npm install
  }
  & npm run build
} finally {
  Pop-Location
}

$cliPath = Join-Path $targetDir "dist\cli.js"
if (-not (Test-Path $cliPath)) {
  Write-Fail "Build output $cliPath not found."
}
Write-Ok "Built CLI: $cliPath"

$prefix = (& npm config get prefix 2>$null)
if ($prefix) {
  $prefix = $prefix.Trim()
}
if (-not $prefix -or -not (Test-Path $prefix)) {
  $prefix = Join-Path $env:APPDATA "npm"
}
if (-not (Test-Path $prefix)) {
  New-Item -ItemType Directory -Path $prefix -Force | Out-Null
}

$commands = @("lattice", "lattice-v2")
foreach ($cmdName in $commands) {
  $cmdFile = Join-Path $prefix "$cmdName.cmd"
  $ps1File = Join-Path $prefix "$cmdName.ps1"

  $cmdContent = "@ECHO off`r`nnode `"$cliPath`" %*`r`n"
  $ps1Content = @"
#!/usr/bin/env pwsh
`$exe = if (`$PSVersionTable.PSVersion -lt "6.0" -or `$IsWindows) { ".exe" } else { "" }
if (`$MyInvocation.ExpectingInput) {
  `$input | & "node`$exe" "$cliPath" `$args
} else {
  & "node`$exe" "$cliPath" `$args
}
exit `$LASTEXITCODE
"@

  Set-Content -Path $cmdFile -Value $cmdContent -Encoding Ascii
  Set-Content -Path $ps1File -Value $ps1Content -Encoding Ascii
  Write-Ok "Registered global command: $cmdName"
}

Write-Step "Verifying installation..."
& node $cliPath --version
Write-Ok "Lattice installed and verified successfully!"
Write-Host "Try running: lattice --help or lattice benchmark --worker mock" -ForegroundColor Yellow
