[CmdletBinding()]
param(
  # Branch or tag to install; defaults to the latest release tag. `irm ... | iex`
  # cannot pass parameters, so the LATTICE_REF and LATTICE_INSTALL_DIR
  # environment variables are honored too. Use `main` for unreleased code.
  [string]$Ref = "",
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
$RepositoryUrl = "https://github.com/moulwyse/lattice.git"
$DefaultRef = "v2.1.0"
if (-not $Ref) { $Ref = if ($env:LATTICE_REF) { $env:LATTICE_REF } else { $DefaultRef } }
if (-not $InstallDir -and $env:LATTICE_INSTALL_DIR) { $InstallDir = $env:LATTICE_INSTALL_DIR }

function Write-Step {
  param([string]$Message)
  Write-Host "[lattice-install] $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "OK: $Message" -ForegroundColor Green
}

# `throw`, not `exit`: under `irm | iex` an exit would close the user's shell.
function Write-Fail {
  param([string]$Message)
  Write-Host "Error: $Message" -ForegroundColor Red
  throw "Lattice installation failed: $Message"
}

# Native commands do not honor $ErrorActionPreference in Windows PowerShell.
function Invoke-Native {
  param([string]$Description, [scriptblock]$Command)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "$Description failed with exit code $LASTEXITCODE."
  }
}

# cmd.exe reads batch files in the OEM code page; PowerShell 5.1 reads a
# BOM-less script as ANSI. Encode shims so non-ASCII profile paths survive.
function Write-Shim {
  param([string]$Path, [string]$Content, [string]$Kind)
  if ($Kind -eq "cmd") {
    $oem = [System.Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    if ($oem.GetString($oem.GetBytes($Content)) -ne $Content) {
      Write-Fail "The path '$Content' cannot be represented in the console code page; choose an ASCII -InstallDir."
    }
    [System.IO.File]::WriteAllBytes($Path, $oem.GetBytes($Content))
  } else {
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($true)))
  }
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
    $origin = (& git -C $targetDir remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or $origin -notmatch 'moulwyse/lattice(\.git)?$') {
      Write-Fail "$targetDir is a Git checkout of another project; choose a different -InstallDir."
    }
    Write-Step "Updating existing installation in $targetDir to $Ref..."
    Invoke-Native "git fetch" { git -C $targetDir fetch --tags --force origin }
    & git -C $targetDir show-ref --verify --quiet "refs/remotes/origin/$Ref"
    if ($LASTEXITCODE -eq 0) {
      Invoke-Native "git checkout" { git -C $targetDir checkout $Ref }
      Invoke-Native "git pull" { git -C $targetDir pull --ff-only origin $Ref }
    } else {
      Invoke-Native "git checkout" { git -C $targetDir checkout --detach $Ref }
    }
  } else {
    # Never delete a directory we did not create: clone only into a missing
    # or empty directory.
    if ((Test-Path $targetDir) -and (Get-ChildItem -Force -LiteralPath $targetDir | Select-Object -First 1)) {
      Write-Fail "$targetDir already exists and is not a Lattice checkout. Remove it yourself or choose a different -InstallDir."
    }
    Write-Step "Cloning Lattice $Ref into $targetDir..."
    Invoke-Native "git clone" { git clone --branch $Ref --depth 1 $RepositoryUrl $targetDir }
  }
} else {
  Write-Step "Using current repository checkout: $targetDir"
}

Write-Step "Installing dependencies and compiling TypeScript..."
Push-Location $targetDir
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) {
    Write-Step "npm ci failed; retrying with npm install..."
    Invoke-Native "npm install" { npm install }
  }
  Invoke-Native "npm run build" { npm run build }
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

  Write-Shim -Path $cmdFile -Content $cmdContent -Kind "cmd"
  Write-Shim -Path $ps1File -Content $ps1Content -Kind "ps1"
  Write-Ok "Registered global command: $cmdName"
}

Write-Step "Verifying installation..."
Invoke-Native "lattice --version" { node $cliPath --version }
Write-Ok "Lattice installed and verified successfully!"
Write-Host "Try running: lattice --help or lattice benchmark --worker mock" -ForegroundColor Yellow
