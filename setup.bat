@echo off
setlocal
pushd "%~dp0" || exit /b 1

for %%T in (node.exe npm.cmd curl.exe) do (
  where %%T >nul 2>&1
  if errorlevel 1 (
    echo Missing %%T. Install Node.js 22.12+ with npm and curl, then retry. >&2
    popd
    exit /b 1
  )
)

node --input-type=module -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error('Node.js 22.12 or newer is required.'); process.exit(1); }"
if errorlevel 1 (
  popd
  exit /b 1
)

call npm.cmd run setup
set "result=%errorlevel%"
if "%result%"=="0" echo Setup complete. Run .\run.bat to start the dance studio.
popd
exit /b %result%
