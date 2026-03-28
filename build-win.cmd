@echo off
setlocal

if not exist node_modules\electron-builder (
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

call npm run build:win
if errorlevel 1 exit /b %errorlevel%

echo.
echo Build finished. Output is in dist\
pause
