@echo off
setlocal
cd /d "%~dp0.."
if errorlevel 1 exit /b 1
echo Lattice: one live RAW vs Lattice pair, GPT-6 Astra / medium.
echo This uses your existing Codex login and consumes model quota.
echo No GitHub upload or new login is performed by this launcher.
echo.
set "LATTICE_CONFIRM="
set /p "LATTICE_CONFIRM=Type YES to spend model quota and start: "
if /i not "%LATTICE_CONFIRM%"=="YES" (
  echo Cancelled. No model request was made.
  pause
  exit /b 2
)
node benchmarks/run-astra.mjs --confirm-live
set "BENCH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %BENCH_EXIT%
