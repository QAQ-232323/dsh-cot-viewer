@echo off
setlocal
title 思维链浏览器 · CoT Reader

set "COT_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%COT_NODE%" set "COT_NODE=node"

if not exist "%~dp0data" mkdir "%~dp0data"

"%COT_NODE%" "%~dp0server.mjs" %*
if errorlevel 1 pause
