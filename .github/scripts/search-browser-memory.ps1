# 測定用Chromiumが返したPIDだけを読み取る。ファイル・プロセスの変更はしない。
$ErrorActionPreference='Stop'
while($null -ne ($taskLine=[Console]::ReadLine())) {
  try {
    $taskRows=@()
    foreach($taskItem in (ConvertFrom-Json $taskLine)) {
      if([string]$taskItem.id -notmatch '^[1-9][0-9]*$'){throw 'Invalid process id'}
      try {
        $taskProcess=Get-Process -Id ([int]$taskItem.id)
        $taskRows+=@{type=[string]$taskItem.type;privateBytes=$taskProcess.PrivateMemorySize64;workingSetBytes=$taskProcess.WorkingSet64}
      } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
    }
    [Console]::WriteLine((ConvertTo-Json -InputObject @{rows=$taskRows} -Compress))
  } catch { [Console]::WriteLine('{"error":"memory_probe"}') }
}
