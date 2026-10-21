param(
  [Parameter(Mandatory=$true)][string]$CaseFile,
  [int]$TimeoutSeconds = 360
)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -LiteralPath $CaseFile -Raw | ConvertFrom-Json
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runRoot = Join-Path $workspace ('.opencode/full-sweep/monitored-' + $spec.label + '-' + [DateTime]::UtcNow.ToString('HHmmss'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$lockPath = Join-Path $workspace '.opencode/full-sweep/monitor.lock'
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$owned = @{}
$child = $null
$stopReason = $null
$exitCode = $null
$highSamples = 0
$started = [DateTime]::UtcNow
$telemetry = Join-Path $runRoot 'resources.jsonl'
$logicalProcessors = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
try {
  if ($spec.env) { foreach ($item in $spec.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($item.Name, [string]$item.Value, 'Process') } }
  $argsList = @($spec.args | ForEach-Object {
    if ($_ -match '["\r\n]' -or $_.EndsWith('\')) { throw 'Unsupported argument quoting' }
    '"' + $_ + '"'
  })
  $bun = (Get-Command bun.exe).Source
  $child = Start-Process -FilePath $bun -ArgumentList $argsList -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runRoot 'stdout.log') -RedirectStandardError (Join-Path $runRoot 'stderr.log')
  $null = $child.Handle
  $owned[$child.Id] = $child.StartTime.ToUniversalTime()
  $child.ProcessorAffinity = [IntPtr]3
  $child.PriorityClass = 'BelowNormal'
  Write-Output (@{event='started';root=$runRoot;pid=$child.Id;affinity='two logical CPUs';label=$spec.label} | ConvertTo-Json -Compress)
  while ($true) {
    $processes = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($row in $processes) { $byId[[int]$row.ProcessId] = $row }
    do {
      $added = $false
      foreach ($row in $processes) {
        $parent = $byId[[int]$row.ParentProcessId]
        $parentMatches = $null -ne $parent -and $null -ne $parent.CreationDate -and $owned.ContainsKey([int]$row.ParentProcessId) -and [Math]::Abs(($parent.CreationDate.ToUniversalTime() - $owned[[int]$row.ParentProcessId]).TotalSeconds) -lt 1
        if ($null -ne $row.CreationDate -and $parentMatches -and -not $owned.ContainsKey([int]$row.ProcessId) -and $row.CreationDate.ToUniversalTime() -ge $owned[[int]$row.ParentProcessId]) {
          $owned[[int]$row.ProcessId] = $row.CreationDate.ToUniversalTime()
          $added = $true
        }
      }
    } while ($added)
    $live = @()
    foreach ($id in @($owned.Keys)) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      try { $processStarted = $p.StartTime.ToUniversalTime() } catch { continue }
      if ([Math]::Abs(($processStarted - $owned[$id]).TotalSeconds) -lt 1) {
        try { $p.ProcessorAffinity = [IntPtr]3; $p.PriorityClass = 'BelowNormal' } catch {}
        $live += $p
      }
    }
    $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
    $network = (Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Measure-Object BytesTotalPersec -Sum).Sum
    $freeMB = [Math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
    $freeDiskGB = [Math]::Round(([IO.DriveInfo]::new([IO.Path]::GetPathRoot($workspace))).AvailableFreeSpace / 1GB, 1)
    $sample = @{utc=[DateTime]::UtcNow.ToString('o');cpuPercent=$cpu;networkBytesPerSecond=$network;freeMB=$freeMB;freeDiskGB=$freeDiskGB;ownedPids=@($live | ForEach-Object {$_.Id});ownedWorkingSetMB=[Math]::Round(($live | Measure-Object WorkingSet64 -Sum).Sum/1MB)}
    $processCpu = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -notin @('_Total','Idle') })
    $sample.ownedCPUPercentApprox = [Math]::Round(($processCpu | Where-Object { $_.IDProcess -in $sample.ownedPids } | Measure-Object PercentProcessorTime -Sum).Sum / $logicalProcessors, 1)
    if ($cpu -ge 60) { $sample.topCPUProcesses = @($processCpu | Sort-Object PercentProcessorTime -Descending | Select-Object -First 4 Name,IDProcess,@{n='machineCPUPercent';e={[Math]::Round($_.PercentProcessorTime / $logicalProcessors,1)}}) }
    $json = $sample | ConvertTo-Json -Compress
    Add-Content -LiteralPath $telemetry -Value $json
    Write-Output $json
    if ($cpu -ge 80 -or $network -ge 2MB -or $freeMB -lt 2048 -or $freeDiskGB -lt 8) { $highSamples++ } else { $highSamples=0 }
    if ($highSamples -ge 3) { $stopReason='resource threshold sustained across three samples'; break }
    $child.Refresh()
    if ($child.HasExited) { $child.WaitForExit(); $exitCode=$child.ExitCode; break }
    if (([DateTime]::UtcNow - $started).TotalSeconds -ge $TimeoutSeconds) { $stopReason='case deadline'; break }
    Start-Sleep -Seconds 5
  }
} catch {
  $stopReason = 'supervisor error: ' + $_.Exception.Message
  Write-Warning $stopReason
} finally {
  # Stop only descendants whose creation timestamps match this invocation.
  foreach ($id in @($owned.Keys)) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    try { $processStarted = $p.StartTime.ToUniversalTime() } catch { continue }
    if ([Math]::Abs(($processStarted - $owned[$id]).TotalSeconds) -lt 1) { Stop-Process -InputObject $p -Force -ErrorAction SilentlyContinue; try { $p.WaitForExit(2000) | Out-Null } catch {} }
  }
  $remaining = @(Get-CimInstance Win32_Process | Where-Object {
    $null -ne $_.CreationDate -and $owned.ContainsKey([int]$_.ProcessId) -and [Math]::Abs(($_.CreationDate.ToUniversalTime() - $owned[[int]$_.ProcessId]).TotalSeconds) -lt 1
  } | ForEach-Object { [int]$_.ProcessId })
  $record = @{label=$spec.label;root=$runRoot;exitCode=$exitCode;stopReason=$stopReason;remainingOwnedPids=$remaining;elapsedSeconds=([DateTime]::UtcNow-$started).TotalSeconds}
  $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runRoot 'result.json')
  Write-Output ($record | ConvertTo-Json -Compress)
  $lock.Dispose()
  Remove-Item -LiteralPath $lockPath
}
if ($stopReason -or $remaining.Count -gt 0) { exit 2 }
if ($null -eq $exitCode) { exit 1 }
exit $exitCode
