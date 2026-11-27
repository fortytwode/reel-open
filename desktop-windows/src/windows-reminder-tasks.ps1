[CmdletBinding()]
param(
    [switch]$Sync,
    [switch]$Diagnostic,
    [string]$PlanPath,
    [string]$Token,
    [string]$Scope,
    [string]$DiagnosticPath,
    [switch]$ValidateLaunchConfig,
    [string]$LaunchConfigPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-TaskPrefix([string]$scopeValue, [string]$diagnosticsFile) {
    if ($scopeValue -notmatch '^[a-f0-9]{64}$') { throw 'Invalid reminder scope.' }
    Write-TaskDiagnostic $diagnosticsFile 'scope-identity-before'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Write-TaskDiagnostic $diagnosticsFile 'scope-identity-after'
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        Write-TaskDiagnostic $diagnosticsFile 'scope-hash-before'
        $sidHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid)))).Replace('-', '').ToLowerInvariant()
        Write-TaskDiagnostic $diagnosticsFile 'scope-hash-after'
    }
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

function Write-TaskDiagnostic([string]$filePath, [string]$phase) {
    if ([string]::IsNullOrEmpty($filePath)) { return }
    try {
        $root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $fullPath = [IO.Path]::GetFullPath($filePath)
        if ($fullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            [IO.File]::AppendAllText($fullPath, $phase + [Environment]::NewLine, [Text.Encoding]::ASCII)
        }
    } catch { }
}

function Read-ReminderLaunchConfiguration([string]$json, [string]$diagnosticsPath) {
    if ($json.Length -gt 65536) { throw 'Invalid reminder launch configuration.' }
    Write-TaskDiagnostic $diagnosticsPath 'launch-parser-assembly-load-before'
    Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
    Write-TaskDiagnostic $diagnosticsPath 'launch-parser-assembly-load-after'
    Write-TaskDiagnostic $diagnosticsPath 'launch-parser-create-before'
    $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
    Write-TaskDiagnostic $diagnosticsPath 'launch-parser-create-after'
    $serializer.MaxJsonLength = 65536
    $serializer.RecursionLimit = 8
    Write-TaskDiagnostic $diagnosticsPath 'launch-json-deserialize-before'
    try { $launch = $serializer.DeserializeObject($json) }
    catch {
        $exception = $_.Exception
        $hresult = '0x' + ([int]$exception.HResult).ToString('X8')
        Write-TaskDiagnostic $diagnosticsPath ('launch-json-deserialize-error:' + $exception.GetType().FullName + ':' + $hresult + ':line=' + [int]$_.InvocationInfo.ScriptLineNumber)
        throw 'Invalid reminder launch configuration.'
    }
    Write-TaskDiagnostic $diagnosticsPath 'launch-json-deserialize-after'
    Write-TaskDiagnostic $diagnosticsPath 'launch-config-schema-check-before'
    if ($launch -isnot [System.Collections.Generic.Dictionary[string,object]] -or -not $launch.ContainsKey('mode')) {
        throw 'Invalid reminder launch configuration.'
    }
    $launchMode = $launch['mode']
    if ($launchMode -isnot [string]) { throw 'Invalid reminder launch configuration.' }
    if ($launchMode -eq 'portable') {
        $allowedKeys = @('mode', 'executable', 'arguments', 'diagnosticsFile', 'waitForChildExit')
        if (-not $launch.ContainsKey('executable') -or -not $launch.ContainsKey('arguments') -or $launch['executable'] -isnot [string] -or $launch['arguments'] -isnot [System.Array]) {
            throw 'Invalid reminder launch configuration.'
        }
        foreach ($argument in $launch['arguments']) {
            if ($argument -isnot [string] -or $argument.Length -gt 2048) { throw 'Invalid reminder launch configuration.' }
        }
        if ($launch['arguments'].Length -gt 16) { throw 'Invalid reminder launch configuration.' }
        if ($launch.ContainsKey('waitForChildExit') -and $launch['waitForChildExit'] -isnot [bool]) {
            throw 'Invalid reminder launch configuration.'
        }
    } elseif ($launchMode -eq 'msix') {
        $allowedKeys = @('mode', 'diagnosticsFile')
    } else { throw 'Invalid reminder launch configuration.' }
    foreach ($key in $launch.Keys) {
        if ($key -notin $allowedKeys) { throw 'Invalid reminder launch configuration.' }
    }
    if ($launch.ContainsKey('diagnosticsFile') -and $launch['diagnosticsFile'] -isnot [string]) {
        throw 'Invalid reminder launch configuration.'
    }
    Write-TaskDiagnostic $diagnosticsPath 'launch-config-schema-check-after'
    return ,$launch
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
    if ($planJson.Trim() -match '^\[\s*\]$') {
        # Windows PowerShell 5.1 emits no pipeline object for JSON [], and @($null)
        # otherwise becomes a one-item null array that fails on $item.token below.
        $plan = @()
    } else {
        $parsedPlan = ConvertFrom-Json -InputObject $planJson
        if ($null -eq $parsedPlan) { throw 'Invalid reminder task plan.' }
        $plan = @($parsedPlan)
    }
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
    $diagnosticPath = ''
    $launchConfigPath = Join-Path $PSScriptRoot 'reminder-launch.json'
    if (Test-Path -LiteralPath $launchConfigPath -PathType Leaf) {
        try {
            $launchConfig = Get-Content -LiteralPath $launchConfigPath -Raw | ConvertFrom-Json
            $candidateDiagnosticPath = [string]$launchConfig.diagnosticsFile
            if (-not [string]::IsNullOrEmpty($candidateDiagnosticPath)) {
                $root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
                $candidate = [IO.Path]::GetFullPath($candidateDiagnosticPath)
                if ($candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $diagnosticPath = $candidate }
            }
        } catch { $diagnosticPath = '' }
    }
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
        if (-not [string]::IsNullOrEmpty($diagnosticPath)) {
            $action.Arguments += ' -DiagnosticPath ' + (Quote-CommandLineArgument $diagnosticPath)
        }
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
    Write-TaskDiagnostic $DiagnosticPath 'trigger-token-validation-before'
    if ($token -notmatch '^[a-f0-9]{32}$') { throw 'Invalid reminder token.' }
    Write-TaskDiagnostic $DiagnosticPath 'trigger-token-validation-after'
    Write-TaskDiagnostic $DiagnosticPath 'trigger-scope-prefix-before'
    $null = Get-TaskPrefix $scopeValue $DiagnosticPath
    Write-TaskDiagnostic $DiagnosticPath 'trigger-scope-prefix-after'
    Write-TaskDiagnostic $DiagnosticPath 'launch-path-combine-before'
    $launchPath = [IO.Path]::Combine($PSScriptRoot, 'reminder-launch.json')
    Write-TaskDiagnostic $DiagnosticPath 'launch-path-combine-after'
    Write-TaskDiagnostic $DiagnosticPath 'launch-path-check-before'
    $launchExists = [IO.File]::Exists($launchPath)
    Write-TaskDiagnostic $DiagnosticPath ('launch-path-check-after:' + [bool]$launchExists)
    if (-not $launchExists) { return }
    $launchFile = [IO.FileInfo]::new($launchPath)
    if ($launchFile.Length -gt 65536) { throw 'Invalid reminder launch configuration.' }
    Write-TaskDiagnostic $DiagnosticPath 'launch-config-read-before'
    $launchJson = [IO.File]::ReadAllText($launchPath)
    Write-TaskDiagnostic $DiagnosticPath ('launch-config-read-after:' + $launchJson.Length)
    Write-TaskDiagnostic $DiagnosticPath 'launch-config-parse-before'
    $launch = Read-ReminderLaunchConfiguration $launchJson $DiagnosticPath
    Write-TaskDiagnostic $DiagnosticPath 'launch-config-parse-after'
    $diagnosticsFile = ''
    if ($launch.ContainsKey('diagnosticsFile')) {
        $diagnosticCandidate = [IO.Path]::GetFullPath([string]$launch['diagnosticsFile'])
        $root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if ($diagnosticCandidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $diagnosticsFile = $diagnosticCandidate }
    }
    Write-TaskDiagnostic $diagnosticsFile 'helper-config-loaded'
    $triggerDir = [IO.Path]::Combine($PSScriptRoot, 'reminder-triggers')
    Write-TaskDiagnostic $diagnosticsFile 'trigger-directory-create-before'
    [IO.Directory]::CreateDirectory($triggerDir) | Out-Null
    Write-TaskDiagnostic $diagnosticsFile 'trigger-directory-create-after'
    $marker = [IO.Path]::Combine($triggerDir, ($token + '.trigger'))
    Write-TaskDiagnostic $diagnosticsFile 'trigger-marker-check-before'
    $markerExists = [IO.File]::Exists($marker)
    Write-TaskDiagnostic $diagnosticsFile ('trigger-marker-check-after:' + [bool]$markerExists)
    if ($markerExists) { Write-TaskDiagnostic $diagnosticsFile 'trigger-marker-already-present'; return }
    Write-TaskDiagnostic $diagnosticsFile 'trigger-marker-create-before'
    $stream = [IO.File]::Open($marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::ASCII.GetBytes($token); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    Write-TaskDiagnostic $diagnosticsFile 'trigger-marker-create-after'
    Write-TaskDiagnostic $diagnosticsFile 'trigger-marker-written'

    if ($launchMode -eq 'msix') {
        $package = Get-AppxPackage -Name 'RocketShipHQ.Reel' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $package) { Write-TaskDiagnostic $diagnosticsFile 'msix-package-not-found'; [IO.File]::Delete($marker); return }
        Start-Process -FilePath ([IO.Path]::Combine($env:WINDIR, 'explorer.exe')) -ArgumentList ('shell:AppsFolder\' + $package.PackageFamilyName + '!Companion') -WindowStyle Hidden
        Write-TaskDiagnostic $diagnosticsFile 'msix-shell-launch-returned'
    } elseif ($launchMode -eq 'portable' -and [IO.Path]::IsPathRooted([string]$launch['executable']) -and [IO.File]::Exists([string]$launch['executable'])) {
        $arguments = @($launch['arguments'] | ForEach-Object { [string]$_ })
        if ($arguments.Count -gt 16 -or @($arguments | Where-Object { $_.Length -gt 2048 }).Count -gt 0) { Write-TaskDiagnostic $diagnosticsFile 'portable-arguments-invalid'; [IO.File]::Delete($marker); return }
        $arguments += '--meeting-reminder-trigger=' + $token
        $argumentLine = (@($arguments | ForEach-Object { Quote-CommandLineArgument $_ }) -join ' ')
        Write-TaskDiagnostic $diagnosticsFile 'portable-start-process-called'
        $child = Start-Process -FilePath ([string]$launch['executable']) -ArgumentList $argumentLine -PassThru -WindowStyle Hidden
        Write-TaskDiagnostic $diagnosticsFile 'portable-start-process-returned'
        $waitForChildExit = $false
        if ($launch.ContainsKey('waitForChildExit')) { $waitForChildExit = $launch['waitForChildExit'] -eq $true }
        if ($waitForChildExit) {
            $child.WaitForExit()
            $child.Refresh()
            Write-TaskDiagnostic $diagnosticsFile ('portable-child-exited:' + [int]$child.ExitCode)
            if ($child.ExitCode -ne 0) { throw 'The reminder smoke child process failed.' }
        }
    } else {
        Write-TaskDiagnostic $diagnosticsFile 'launch-mode-invalid'
        [IO.File]::Delete($marker)
    }
}

try {
    Write-TaskDiagnostic $DiagnosticPath 'helper-script-entry'
    if ($ValidateLaunchConfig) {
        if ([string]::IsNullOrEmpty($LaunchConfigPath) -or -not [IO.File]::Exists($LaunchConfigPath)) {
            throw 'Reminder launch configuration is unavailable.'
        }
        $launchFile = [IO.FileInfo]::new($LaunchConfigPath)
        if ($launchFile.Length -gt 65536) { throw 'Invalid reminder launch configuration.' }
        $launchJson = [IO.File]::ReadAllText($LaunchConfigPath)
        $null = Read-ReminderLaunchConfiguration $launchJson $DiagnosticPath
    } elseif ($Sync) { Sync-ReminderTasks $PlanPath $Scope $Diagnostic }
    else { Deliver-ReminderTrigger $Token $Scope }
} catch {
    if ($Diagnostic -or -not [string]::IsNullOrEmpty($DiagnosticPath)) {
        $exception = $_.Exception
        $hresult = '0x' + ([int]$exception.HResult).ToString('X8')
        Write-TaskDiagnostic $DiagnosticPath ('helper-exception:' + $exception.GetType().FullName + ':' + $hresult + ':line=' + [int]$_.InvocationInfo.ScriptLineNumber)
        [Console]::Error.WriteLine(('Reminder task diagnostic: exception={0}; hresult={1}; line={2}' -f
            $exception.GetType().FullName, $hresult, $_.InvocationInfo.ScriptLineNumber))
    }
    [Console]::Error.WriteLine('Reel meeting reminder task failed.')
    exit 1
}
