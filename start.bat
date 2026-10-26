@echo off
rem Start ASound: runs the local server and opens the app in your browser (Edge or Chrome recommended).
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" server.py
) else (
  python server.py
)
pause
