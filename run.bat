@echo off
setlocal
pushd "%~dp0" || exit /b 1

if not exist node_modules\ (
  echo Dependencies are missing. Run .\setup.bat first. >&2
  popd
  exit /b 1
)
if not exist public\models\pose_landmarker_lite.task (
  echo Pose model missing: camera tracking requires a successful .\setup.bat. Audio and coach practice are still available. >&2
)

call npm.cmd start -- %*
set "result=%errorlevel%"
popd
exit /b %result%
