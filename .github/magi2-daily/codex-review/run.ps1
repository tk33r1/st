# タスクスケジューラが1時間ごとに起動する（install.ps1 が %LOCALAPPDATA%\magi2-review へ写す）。
# 専用のcloneをmainの最新にそろえ、mainの版のスクリプトだけを動かす。本人の作業コピーには触れない。
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'magi2-review'
$repo = Join-Path $base 'repo'
if (-not (Test-Path (Join-Path $repo '.git'))) { git clone --quiet --no-checkout https://github.com/tk33r1/st.git $repo }
git -C $repo -c core.hooksPath=NUL fetch --quiet --no-tags origin main
git -C $repo -c core.hooksPath=NUL -c core.autocrlf=false checkout --quiet --detach --force origin/main
node (Join-Path $repo '.github\scripts\magi2-daily-codex-review.mjs') --run
exit $LASTEXITCODE
