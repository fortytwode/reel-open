[CmdletBinding()]
param(
    [switch]$Sync,
    [switch]$Diagnostic,
    [string]$PlanPath,
    [string]$Token,
    [string]$Scope
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-TaskPrefix([string]$scopeValue) {
    if ($scopeValue -notmatch '^[a-f0-9]{64}$') { throw 'Invalid reminder scope.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $sidHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return "ReelReminder_${scopeValue}_${sidHash}_"
}

function New-TaskService {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    return $service
}

function Quote-CommandLineArgument([string]$value) {
    $escaped = $value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function ConvertTo-UtcDateTimeOffset($value) {
    if ($value -is [DateTimeOffset]) { return $value.ToUniversalTime() }
    if ($value -is [DateTime]) {
        $date = $value
        if ($date.Kind -eq [DateTimeKind]::Unspecified) { $date = [DateTime]::SpecifyKind($date, [DateTimeKind]::Utc) }
        return [DateTimeOffset]::new($date.ToUniversalTime())
    }
    return [DateTimeOffset]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
}

function Sync-ReminderTasks([string]$planPath, [string]$scopeValue) {
    if (-not [IO.Path]::IsPathRooted($planPath) -or -not (Test-Path -LiteralPath $planPath -PathType Leaf)) {
        throw 'Reminder task plan is unavailable.'
    }
    $planJson = Get-Content -LiteralPath $planPath -Raw
    $plan = @(ConvertFrom-Json -InputObject $planJson)
    if ($plan.Count -gt 32) { throw 'Invalid reminder task plan.' }
    $prefix = Get-TaskPrefix $scopeValue
    $wanted = @{}
    foreach ($item in $plan) {
        if ($item.token -notmatch '^[a-f0-9]{32}$') { throw 'Invalid reminder task entry.' }
        try {
            $start = ConvertTo-UtcDateTimeOffset $item.start
            $end = ConvertTo-UtcDateTimeOffset $item.end
        } catch { throw 'Invalid reminder task entry.' }
        if ($end -le $start) { throw 'Invalid reminder task entry.' }
        $wanted[$item.token] = $start
        $isRetry = $item.PSObject.Properties.Name -contains 'retry' -and $item.retry -eq $true
        if ($isRetry) {
            $wanted[$item.token] = [pscustomobject]@{ start=$wanted[$item.token]; end=$end; retry=$true }
        } else {
            $wanted[$item.token] = [pscustomobject]@{ start=$wanted[$item.token]; end=$end; retry=$false }
        }
    }
    $service = New-TaskService
    $folder = $service.GetFolder('\')
    foreach ($existing in @($folder.GetTasks(0))) {
        if ($existing.Name.StartsWith($prefix, [StringComparison]::Ordinal)) {
            $token = $existing.Name.Substring($prefix.Length)
            if (-not $wanted.ContainsKey($token)) { $folder.DeleteTask($existing.Name, 0) }
        }
    }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $currentName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $registeredCount = 0
    $rearmedCount = 0
    $skippedAtEndCount = 0
    $skippedPastCount = 0
    $timingDiagnostics = [System.Collections.Generic.List[object]]::new()
    foreach ($token in $wanted.Keys) {
        $entry = $wanted[$token]
        $planStartUtcMs = $entry.start.ToUnixTimeMilliseconds()
        $planEndUtcMs = $null
        if ($null -ne $entry.end) { $planEndUtcMs = $entry.end.ToUnixTimeMilliseconds() }
        $start = $entry.start
        $syncNow = [DateTimeOffset]::UtcNow
        if ($start -le [DateTimeOffset]::UtcNow) {
            $syncNow = [DateTimeOffset]::UtcNow
            $start = $syncNow.AddSeconds(15)
            $rearmedCount++
            if ($null -eq $entry.end -or $start -ge $entry.end) {
                $folder.DeleteTask($prefix + $token, 0); $skippedAtEndCount++
                if ($Diagnostic) { $timingDiagnostics.Add([pscustomobject]@{ planStartUtcMs=$planStartUtcMs; planEndUtcMs=$planEndUtcMs; syncNowUtcMs=$syncNow.ToUnixTimeMilliseconds(); candidateUtcMs=$start.ToUnixTimeMilliseconds(); decision='end-before-round' }) }
                continue
            }
        }
        $ticksWithinSecond = $start.Ticks % [TimeSpan]::TicksPerSecond
        if ($ticksWithinSecond -ne 0) {
            $start = $start.AddTicks([TimeSpan]::TicksPerSecond - $ticksWithinSecond)
        }
        if ($null -ne $entry.end -and $start -ge $entry.end) {
            $folder.DeleteTask($prefix + $token, 0); $skippedAtEndCount++
            if ($Diagnostic) { $timingDiagnostics.Add([pscustomobject]@{ planStartUtcMs=$planStartUtcMs; planEndUtcMs=$planEndUtcMs; syncNowUtcMs=$syncNow.ToUnixTimeMilliseconds(); candidateUtcMs=$start.ToUnixTimeMilliseconds(); decision='end-after-round' }) }
            continue
        }
        if ($start -le [DateTimeOffset]::UtcNow) {
            $skippedPastCount++
            if ($Diagnostic) { $timingDiagnostics.Add([pscustomobject]@{ planStartUtcMs=$planStartUtcMs; planEndUtcMs=$planEndUtcMs; syncNowUtcMs=$syncNow.ToUnixTimeMilliseconds(); candidateUtcMs=$start.ToUnixTimeMilliseconds(); decision='past' }) }
            continue
        }
        $task = $service.NewTask(0)
        $task.RegistrationInfo.Description = 'Local opt-in Reel meeting reminder.'
        $task.Principal.UserId = $currentSid
        $task.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN: no stored password.
        $task.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA: never request elevation.
        $task.Settings.Enabled = $true
        $task.Settings.StartWhenAvailable = $true
        $task.Settings.DisallowStartIfOnBatteries = $false
        $task.Settings.StopIfGoingOnBatteries = $false
        $task.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
        $task.Settings.ExecutionTimeLimit = 'PT2M'
        $trigger = $task.Triggers.Create(1) # TASK_TRIGGER_TIME
        $trigger.StartBoundary = $start.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
        $action = $task.Actions.Create(0) # TASK_ACTION_EXEC
        $action.Path = $powershell
        $action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Token ' + $token + ' -Scope ' + $scopeValue
        $taskName = $prefix + $token
        $null = $folder.RegisterTaskDefinition($taskName, $task, 6, $currentName, $null, 3, $null) # CREATE_OR_UPDATE, INTERACTIVE_TOKEN
        $registeredCount++
        if ($Diagnostic) { $timingDiagnostics.Add([pscustomobject]@{ planStartUtcMs=$planStartUtcMs; planEndUtcMs=$planEndUtcMs; syncNowUtcMs=$syncNow.ToUnixTimeMilliseconds(); candidateUtcMs=$start.ToUnixTimeMilliseconds(); decision='registered' }) }
    }
    $summary = [ordered]@{ registered=$registeredCount; rearmed=$rearmedCount; skippedAtEnd=$skippedAtEndCount; skippedPast=$skippedPastCount }
    if ($Diagnostic) { $summary['timing'] = @($timingDiagnostics.ToArray()) }
    [pscustomobject]$summary | ConvertTo-Json -Compress -Depth 4
}

function Deliver-ReminderTrigger([string]$token, [string]$scopeValue) {
    if ($token -notmatch '^[a-f0-9]{32}$') { throw 'Invalid reminder token.' }
    $null = Get-TaskPrefix $scopeValue
    $triggerDir = Join-Path $PSScriptRoot 'reminder-triggers'
    New-Item -ItemType Directory -Force -Path $triggerDir | Out-Null
    $marker = Join-Path $triggerDir ($token + '.trigger')
    if (Test-Path -LiteralPath $marker) { return }
    $stream = [IO.File]::Open($marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::ASCII.GetBytes($token); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }

    $launchPath = Join-Path $PSScriptRoot 'reminder-launch.json'
    if (-not (Test-Path -LiteralPath $launchPath -PathType Leaf)) { Remove-Item -LiteralPath $marker -Force; return }
    $launch = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
    if ($launch.mode -eq 'msix') {
        $package = Get-AppxPackage -Name 'RocketShipHQ.Reel' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $package) { Remove-Item -LiteralPath $marker -Force; return }
        Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $package.PackageFamilyName + '!Companion') -WindowStyle Hidden
    } elseif ($launch.mode -eq 'portable' -and [IO.Path]::IsPathRooted([string]$launch.executable) -and (Test-Path -LiteralPath $launch.executable -PathType Leaf)) {
        $arguments = @()
        if ($launch.arguments -is [System.Array]) { $arguments = @($launch.arguments | ForEach-Object { [string]$_ }) }
        if ($arguments.Count -gt 16 -or @($arguments | Where-Object { $_.Length -gt 2048 }).Count -gt 0) { Remove-Item -LiteralPath $marker -Force; return }
        $arguments += '--meeting-reminder-trigger=' + $token
        $argumentLine = (@($arguments | ForEach-Object { Quote-CommandLineArgument $_ }) -join ' ')
        Start-Process -FilePath ([string]$launch.executable) -ArgumentList $argumentLine -WindowStyle Hidden
    } else {
        Remove-Item -LiteralPath $marker -Force
    }
}

try {
    if ($Sync) { Sync-ReminderTasks $PlanPath $Scope $Diagnostic }
    else { Deliver-ReminderTrigger $Token $Scope }
} catch {
    if ($Diagnostic) {
        $exception = $_.Exception
        $hresult = '0x{0:X8}' -f [uint32]$exception.HResult
        [Console]::Error.WriteLine(('Reminder task diagnostic: exception={0}; hresult={1}; line={2}' -f
            $exception.GetType().FullName, $hresult, $_.InvocationInfo.ScriptLineNumber))
    }
    [Console]::Error.WriteLine('Reel meeting reminder task failed.')
    exit 1
}
