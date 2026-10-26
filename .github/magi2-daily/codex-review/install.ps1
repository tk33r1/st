# 本人が自宅PCで1回だけ実行する。設定ファイル・Appの鍵の置き場・1時間ごとのタスクを作る。
# 例: pwsh -File install.ps1 -AppId 1234567 -AppSlug tk-st-magi2-review -PrivateKeyFile C:\Users\me\Downloads\tk-st-magi2-review.pem
param(
  [Parameter(Mandatory)][string]$AppId,
  [Parameter(Mandatory)][string]$AppSlug,
  [Parameter(Mandatory)][string]$PrivateKeyFile,
  [string]$Model = 'gpt-6.1-sol'
)
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'magi2-review'
New-Item -ItemType Directory -Force $base | Out-Null
# 鍵は本人だけが読めるようにする。リポジトリや同期フォルダには置かない。
$pem = Join-Path $base 'app.pem'
Copy-Item -LiteralPath $PrivateKeyFile -Destination $pem -Force
icacls $pem /inheritance:r /grant:r "${env:USERNAME}:(R)" | Out-Null
@{ app_id = $AppId; app_slug = $AppSlug; private_key_file = $pem; model = $Model } | ConvertTo-Json | Set-Content -Encoding utf8NoBOM (Join-Path $base 'config.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination (Join-Path $base 'run.ps1') -Force
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell).Source }
$action = New-ScheduledTaskAction -Execute $shell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$base\run.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(25) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable -RunOnlyIfNetworkAvailable
Register-ScheduledTask -TaskName 'MAGI2 Codex review' -Action $action -Trigger $trigger -Settings $settings -Force `
  -Description 'MAGI継続改善の交互レビュー（ChatGPT側）。tk33r1/st の区分AのPRへの依頼を受理し、codex execの結果を専用Appで投稿する。' | Out-Null
Write-Output "登録しました。毎時25分に動きます。記録: $base\review.log"
