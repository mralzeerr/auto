@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    مساعد BYD ليبرد 8 - جاري التشغيل...
echo ============================================
start "" "http://localhost:8017"
python server.py
pause
