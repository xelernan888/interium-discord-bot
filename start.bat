@echo off
cd /d "%~dp0"
if not exist .env (
  echo Create .env and put DISCORD_TOKEN=your_bot_token
  pause
  exit /b 1
)
if not exist node_modules npm install
node src\index.js
pause
