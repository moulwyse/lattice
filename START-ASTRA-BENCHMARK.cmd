@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1
echo Lattice: one live RAW vs Lattice pair, GPT-6 Astra / medium.
echo This uses your existing Codex login and may consume model quota.
echo No GitHub upload or new login is performed by this launcher.
echo.
node benchmarks/run-astra.mjs --confirm-live
set "BENCH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %BENCH_EXIT%
