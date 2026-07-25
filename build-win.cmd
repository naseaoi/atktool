@echo off
setlocal

if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

if not exist node_modules\electron-builder (
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

call npm run build:win
if errorlevel 1 exit /b %errorlevel%

echo.
echo Build finished. Output is in dist\
pause
