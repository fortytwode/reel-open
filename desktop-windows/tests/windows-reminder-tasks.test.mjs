import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEncryptedReminderStore, createWindowsReminderTaskManager } from '../src/windows-reminder-tasks.mjs';

const scope='a'.repeat(64), token='b'.repeat(32), start='2026-11-26T10:00:00.250Z', end='2026-11-26T10:30:00.000Z';
function temp() { return mkdtempSync(path.join(os.tmpdir(),'reel-reminder-test-')); }

test('task registration input contains only opaque tokens and UTC event bounds', () => {
  const root=temp(), calls=[];let plan;
  try {
    const executable=path.join(root,'Program Files','Reel.exe');
    const manager=createWindowsReminderTaskManager({stateRoot:root,scope,executable,
      exec:(...args)=>{calls.push(args);const planPath=args[1][args[1].indexOf('-PlanPath')+1];plan=JSON.parse(readFileSync(planPath,'utf8'));}});
    manager.sync([{token,start,end}]);
    assert.equal(calls.length,1);
    const command=calls[0];
    assert.equal(command[0],'powershell.exe');
    const launchConfig=JSON.parse(readFileSync(manager.launchPath,'utf8'));
    assert.equal(launchConfig.executable,executable);
    assert.deepEqual(Object.keys(launchConfig).sort(),['arguments','executable','mode'],
      'Generated production launch config omits the diagnostic path and child-wait smoke options.');
    assert.deepEqual(plan,[{token,start,end}]);
    assert.throws(()=>manager.sync([{token,start}]),TypeError,'Every scheduled meeting must provide an end bound.');
    assert.equal(JSON.stringify(plan).includes('private calendar title'),false);
    assert.equal(command[1].includes('-ExecutionPolicy'),true);
    assert.equal(command[2].windowsHide,true);
    assert.equal(command[2].timeout,30_000);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('encrypted schedule storage never writes meeting details as plaintext', () => {
  const root=temp(), file=path.join(root,'schedule.encrypted');
  try {
    const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value).map(byte=>byte^0x5a),
      decryptString:value=>Buffer.from(value).map(byte=>byte^0x5a).toString()};
    const store=createEncryptedReminderStore({safeStorage,filePath:file});
    const records=[{token,owner:'owner-private',meetingID:'private-event',title:'Private title',start,end:'2026-11-26T10:30:00.000Z'}];
    store.save(records);
    const disk=readFileSync(file,'utf8');
    assert.equal(disk.includes('private-event'),false);
    assert.equal(disk.includes('Private title'),false);
    assert.deepEqual(store.load(),records);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('persistent reminder files are included in the portable runtime allowlist', () => {
  const root=fileURLToPath(new URL('..',import.meta.url));
  const build=readFileSync(path.join(root,'build-portable.ps1'),'utf8');
  const msix=readFileSync(path.join(root,'build-msix.ps1'),'utf8');
  const workflow=readFileSync(path.join(root,'..','.github','workflows','windows-package.yml'),'utf8');
  const smoke=readFileSync(path.join(root,'tests','windows-reminder-task.smoke.mjs'),'utf8');
  const allowlist=build.match(/\$productFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? '';
  assert.match(allowlist,/desktop-windows\/src\/windows-reminder-tasks\.mjs/);
  assert.match(allowlist,/desktop-windows\/src\/windows-reminder-tasks\.ps1/);
  const taskHelper=readFileSync(path.join(root,'src','windows-reminder-tasks.ps1'),'utf8').replace(/\r\n/g,'\n');
  assert.ok(taskHelper.includes(String.raw`$planJson.Trim() -match '^\[\s*\]$'`)
    && taskHelper.includes('$plan = @()') && taskHelper.includes('$null -eq $parsedPlan'),
    'An empty JSON array means cancel all tasks, while JSON null remains an invalid plan.');
  assert.match(taskHelper,/ticksWithinSecond[\s\S]*AddTicks\(/,
    'Fractional meeting starts are rounded upward before Task Scheduler registration.');
  assert.match(taskHelper,/\$null -ne \$entry\.end -and \$start -ge \$entry\.end/,
    'A rounded boundary at or after meeting end is not registered.');
  assert.match(taskHelper,/\$start -le \[DateTimeOffset\]::UtcNow[\s\S]*AddSeconds\(15\)[\s\S]*\$null -eq \$entry\.end -or \$start -ge \$entry\.end/,
    'A sync that arrives after meeting start retries soon only while the meeting is still active.');
  assert.match(taskHelper,/ToString\("yyyy-MM-dd'T'HH:mm:ss'Z'"/,
    'Task Scheduler receives whole-second boundaries after they are safely rounded upward.');
  assert.match(taskHelper,/ConvertTo-UtcDateTimeOffset\(\$value\)[\s\S]*\$value -is \[DateTime\][\s\S]*\$date\.Kind[\s\S]*ToUniversalTime/,
    'PowerShell preserves UTC DateTime kind instead of stringifying JSON timestamps in the runner timezone.');
  assert.match(taskHelper,/ConvertTo-UtcDateTimeOffset \$item\.start[\s\S]*ConvertTo-UtcDateTimeOffset \$item\.end/,
    'Both regular and retry plans parse their required UTC end bound directly.');
  assert.match(smoke,/GetTask\('\$\{taskName\}'\)/,
    'The trigger run uses the exact validated task name instead of a COM-serialized name field.');
  assert.match(smoke,/lastTaskResult=\[int\]\$t\.LastTaskResult[\s\S]*principalMatchesCurrent[\s\S]*logonType=/,
    'The Windows smoke reports the real registered action result and verifies its current-user interactive principal.');
  assert.match(smoke,/\$null=\$t\.Run\(\$null\)[\s\S]*lastTaskResult,0/,
    'The Windows smoke runs the registered task and checks its action result.');
  assert.match(smoke,/taskLaunchDiagnostics = \(name, scriptName='meeting-reminder-task\[\.\]ps1'\)[\s\S]*CommandLine -match '\$\{scriptName\}'[\s\S]*matchedProcesses=\$processes;recentSchedulerEvents=\$events/,
    'A stalled task reports sanitized matching process/session/runtime and Task Scheduler event diagnostics without exposing command lines.');
  assert.match(smoke,/runPowerShellStartupProbe[\s\S]*scheduler-startup-probe\.ps1[\s\S]*entryMs:entryAt-requestedAt[\s\S]*startupTiming\.entryMs\+10_000/,
    'Windows CI measures an interactive scheduled PowerShell no-op before deriving the product action wait bound.');
  assert.match(taskHelper,/Write-TaskDiagnostic \$DiagnosticPath 'helper-script-entry'/,
    'The scheduled reminder helper records entry before it begins account and launch configuration work.');
  assert.match(taskHelper,/scope-identity-before[\s\S]*WindowsIdentity\]::GetCurrent\(\)\.User\.Value[\s\S]*scope-identity-after[\s\S]*scope-hash-before[\s\S]*ComputeHash[\s\S]*scope-hash-after/,
    'Smoke diagnostics bracket account identity and scope hashing so a slow call can be isolated.');
  const deliveryFunction=taskHelper.match(/function Deliver-ReminderTrigger[\s\S]*?(?=\n}\n\ntry)/)?.[0] ?? '';
  const launchParserFunction=taskHelper.match(/function Read-ReminderLaunchConfiguration[\s\S]*?(?=\n}\n\nfunction ConvertTo-UtcDateTimeOffset)/)?.[0] ?? '';
  assert.match(deliveryFunction,/\[IO\.Path\]::Combine\(\$PSScriptRoot, 'reminder-launch\.json'\)[\s\S]*\[IO\.File\]::Exists\(\$launchPath\)[\s\S]*\[IO\.File\]::ReadAllText\(\$launchPath\)[\s\S]*launch-config-parse-after/,
    'The trigger path uses .NET path/file APIs and separately marks config existence, read and JSON parse.');
  assert.match(launchParserFunction,/System\.Web\.Extensions[\s\S]*JavaScriptSerializer\]::new\(\)[\s\S]*MaxJsonLength = 65536[\s\S]*RecursionLimit = 8[\s\S]*DeserializeObject\(\$json\)/,
    'Cold-path JSON parsing uses the bounded .NET Framework parser available to Windows PowerShell 5.1.');
  assert.match(launchParserFunction,/\$launch -isnot \[System\.Collections\.Generic\.Dictionary\[string,object\]\][\s\S]*ContainsKey\('mode'\)[\s\S]*\$allowedKeys[\s\S]*-notin \$allowedKeys[\s\S]*diagnosticsFile/,
    'The launch parser requires an object and rejects fields outside the portable/MSIX schema.');
  assert.doesNotMatch(launchParserFunction,/\.Contains\(/,
    'The generic dictionary is queried with its public ContainsKey API rather than the IDictionary overload.');
  assert.doesNotMatch(launchParserFunction,/ConvertFrom-Json/,
    'Scheduled delivery does not invoke the slow PowerShell JSON cmdlet on the ARM cold path.');
  assert.match(launchParserFunction,/launch-parser-assembly-load-before[\s\S]*Add-Type -AssemblyName System\.Web\.Extensions[\s\S]*launch-parser-assembly-load-after[\s\S]*launch-parser-create-before[\s\S]*launch-parser-create-after[\s\S]*launch-json-deserialize-before[\s\S]*launch-json-deserialize-after[\s\S]*launch-config-schema-check-before[\s\S]*launch-config-schema-check-after/,
    'The scheduled smoke can distinguish parser assembly load, serializer construction, JSON parse and schema validation.');
  assert.ok(launchParserFunction.includes("'launch-json-deserialize-error:'")
    && launchParserFunction.includes('$exception.GetType().FullName')
    && launchParserFunction.includes('$exception.HResult')
    && launchParserFunction.includes('ScriptLineNumber'),
    'Parser errors retain only safe exception type, HRESULT and source line for diagnostics.');
  assert.doesNotMatch(deliveryFunction,/\b(?:Join-Path|Test-Path|Get-Content|New-Item|Remove-Item)\b/,
    'Scheduled delivery does not invoke filesystem provider cmdlets on its cold PowerShell path.');
  assert.match(taskHelper,/\$launch\.ContainsKey\('diagnosticsFile'\)/,
    'Production launch configuration safely omits the smoke-only diagnostic field under StrictMode.');
  assert.match(taskHelper,/\$launch\.ContainsKey\('waitForChildExit'\)/,
    'Production portable launch configuration safely omits the smoke-only child wait flag under StrictMode.');
  assert.match(smoke,/Object\.hasOwn\(productionLaunchConfig,'diagnosticsFile'\),false[\s\S]*Object\.hasOwn\(productionLaunchConfig,'waitForChildExit'\),false[\s\S]*productionLaunchConfig[\s\S]*The production launch configuration delivers the reminder trigger[\s\S]*productionStatus\.lastTaskResult,0/,
    'Windows CI runs and verifies an actual reminder task with production launch JSON and absent optional diagnostic properties.');
  assert.match(smoke,/security\.command\)\.toLowerCase\(\),\/\^powershell/,
    'The registered action executable is validated as Windows PowerShell.');
  assert.match(smoke,/const deadline = Date\.now\(\)\+taskWaitMs[\s\S]*completed=hasDeliveredTrigger\(\)[\s\S]*finalStatus\.state!==4[\s\S]*finalStatus\.lastTaskResult!==267009/,
    'Trigger delivery is required alongside a completed, non-running scheduler action within the measured bounded wait.');
  assert.ok(smoke.indexOf("command('run registered task through Task Scheduler COM'")
    < smoke.indexOf('manager.sync([{token,start:alreadyDueRetry'),
    'The actual task action runs before the due-retry fixture can create an overlapping scheduled trigger.');
  assert.ok(workflow.indexOf('Snapshot runner and verify reminders before model inference')
    < workflow.indexOf('Verify packaged local Whisper inference and offline cache'),
    'Task Scheduler smoke runs before high-memory model inference on the Windows package runner.');
  assert.ok(workflow.indexOf('Parse reminder helper with Windows PowerShell 5.1')
    < workflow.indexOf('Install pinned local Whisper browser runtime'),
    'Windows PowerShell 5.1 parses the helper before installs, packaging and model inference.');
  assert.match(workflow,/\[System\.Management\.Automation\.Language\.Parser\]::ParseFile\([\s\S]*\$parseErrors\.Count/,
    'The early PowerShell preflight uses the PowerShell AST parser and fails on syntax errors.');
  assert.match(workflow,/Add-Type -AssemblyName System\.Web\.Extensions[\s\S]*JavaScriptSerializer\]::new\(\)[\s\S]*DeserializeObject[\s\S]*\$portable[\s\S]*\$msix/,
    'The early Windows PowerShell 5.1 preflight verifies the parser assembly and both production launch JSON shapes.');
  assert.match(workflow,/portable-production[\s\S]*portable-diagnostic[\s\S]*msix-production[\s\S]*msix-diagnostic[\s\S]*-ValidateLaunchConfig -LaunchConfigPath[\s\S]*Windows PowerShell 5\.1 rejected reminder config/,
    'Windows PowerShell 5.1 invokes the full helper validator for production and diagnostic portable/MSIX JSON.');
  assert.match(workflow,/portable-production[\s\S]*portable-diagnostic[\s\S]*msix-production[\s\S]*msix-diagnostic[\s\S]*-ValidateLaunchConfig -LaunchConfigPath[\s\S]*Windows PowerShell 5\.1 rejected reminder config/,
    'Windows PowerShell 5.1 invokes the helper’s full schema validator for all four production/diagnostic launch shapes.');
  assert.ok(workflow.includes('Snapshot runner after packaged local Whisper inference')
    && workflow.includes('Sanitized Whisper cache directories remaining')
    && workflow.includes('Remove-Item -LiteralPath $cache.FullName -Recurse -Force'),
    'The Windows package job records leftover Electron/model resources and removes only its smoke-owned cache directories.');
  assert.match(smoke,/receiver\.mjs[\s\S]*process\.argv\.find\(argument => \/\^--meeting-reminder-trigger=/,
    'The portable task smoke receiver accepts the same argv trigger flag as the Electron app.');
  assert.doesNotMatch(smoke,/\b(?:info|retried|delayedTask)\.name\b/,
    'The smoke does not depend on COM properties that PowerShell JSON serialization omits.');
  assert.match(smoke,/const delayedInfo=taskQuery\(taskName\), delayedSecurity=taskSecurity\(taskName\)[\s\S]*delayedSecurity\.name,taskName/,
    'Delayed registration is verified through an exact-name scheduler XML query.');
  assert.match(taskHelper,/\.Principal\.LogonType\s*=\s*3/);
  assert.match(taskHelper,/\.Principal\.RunLevel\s*=\s*0/,
    'Tasks must use the current interactive token at the least-privileged run level.');
  for(const phase of ['helper-script-entry','helper-config-loaded','trigger-marker-written','portable-start-process-called',
    'portable-start-process-returned','portable-child-exited:']) {
    assert.ok(taskHelper.includes(phase),`The task helper reports sanitized launch milestone ${phase}.`);
  }
  for(const phase of ['receiver-started','receiver-trigger-accepted','receiver-exited:0','portable-child-exited:0']) {
    assert.ok(smoke.includes(phase),`The Windows smoke checks sanitized child milestone ${phase}.`);
  }
  assert.match(taskHelper,/\[int\]\$exception\.HResult\)\.ToString\('X8'\)[\s\S]*Reminder task diagnostic: exception=.*hresult=.*line=/,
    'The Windows smoke can report negative HRESULTs safely with sanitized exception type and source line.');
  assert.match(taskHelper,/\$Diagnostic -or -not \[string\]::IsNullOrEmpty\(\$DiagnosticPath\)[\s\S]*Write-TaskDiagnostic \$DiagnosticPath \('helper-exception:'/,
    'Scheduled trigger failures write sanitized exception diagnostics even when the optional sync diagnostic switch is absent.');
  assert.match(smoke,/manager\.sync\(\[\]\)[\s\S]*taskCount\(\),0[\s\S]*Opt-out cleanup removes/,
    'The Windows scheduler smoke exercises empty-plan deletion and verifies no task remains.');
  assert.match(msix,/<desktop:ToastNotificationActivation ToastActivatorCLSID="\$toastActivatorClsid" \/>/);
  assert.match(msix,/<com:Class Id="\$toastActivatorClsid" \/>/,
    'The MSIX manifest uses schema-valid unbraced GUID values for Electron toast activation.');
});
