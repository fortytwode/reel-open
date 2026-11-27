import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEncryptedReminderStore, createWindowsReminderTaskManager, serializeReminderLaunchConfig } from '../src/windows-reminder-tasks.mjs';

const scope='a'.repeat(64), token='b'.repeat(32), start='2026-11-26T10:00:00.250Z', end='2026-11-26T10:30:00.000Z';
function temp() { return mkdtempSync(path.join(os.tmpdir(),'reel-reminder-test-')); }

test('task registration input contains only opaque tokens and UTC event bounds', () => {
  const root=temp(), calls=[];let plan;
  try {
    const executable=path.join(root,'Program Files','Reel.exe');
    const legacyConfigPath=path.join(root,'reminder-launch.json');
    const legacyConfig=JSON.stringify({mode:'portable',executable,arguments:[]});
    writeFileSync(legacyConfigPath,legacyConfig);
    const manager=createWindowsReminderTaskManager({stateRoot:root,scope,executable,
      exec:(...args)=>{calls.push(args);const planPath=args[1][args[1].indexOf('-PlanPath')+1];plan=JSON.parse(readFileSync(planPath,'utf8'));}});
    manager.sync([{token,start,end}]);
    assert.equal(calls.length,1);
    const command=calls[0];
    assert.equal(command[0],'powershell.exe');
    const launchLines=readFileSync(manager.launchPath,'utf8').trim().split('\n');
    const launchFields=new Map(launchLines.map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
    assert.equal(path.basename(manager.launchPath),'reminder-launch.v2.conf');
    assert.equal(launchFields.get('version'),'2');
    assert.equal(launchFields.get('mode'),'portable');
    assert.equal(Buffer.from(launchFields.get('executableB64'),'base64').toString('utf8'),executable);
    assert.equal(launchFields.get('argumentCount'),'0');
    assert.equal(launchFields.has('diagnosticsFileB64'),false,'Generated production config omits the diagnostic path.');
    assert.equal(launchFields.has('waitForChildExit'),false,'Generated production config omits the smoke child wait flag.');
    assert.equal(readFileSync(legacyConfigPath,'utf8'),legacyConfig,'Upgrade preparation leaves the old helper’s JSON config untouched.');
    assert.equal(existsSync(manager.scriptPath),true);
    assert.throws(()=>serializeReminderLaunchConfig({mode:'portable',executable,arguments:Array(17).fill('x')}),TypeError,
      'The serializer enforces the same bounded argument count as the task helper.');
    const multilineArgument='--caption=one=two\nsecond line';
    const safeConfig=serializeReminderLaunchConfig({mode:'portable',executable,arguments:[multilineArgument]});
    assert.equal(safeConfig.toString('utf8').split('\n').length,6,'Newlines and equals in values cannot inject config fields.');
    assert.equal(Buffer.from(safeConfig.toString('utf8').match(/argument\.0=([^\n]+)/)[1],'base64').toString('utf8'),multilineArgument);
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
  const msixUpdate=readFileSync(path.join(root,'test-msix-update.ps1'),'utf8');
  const smoke=readFileSync(path.join(root,'tests','windows-reminder-task.smoke.mjs'),'utf8');
  const taskManager=readFileSync(path.join(root,'src','windows-reminder-tasks.mjs'),'utf8');
  const allowlist=build.match(/\$productFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? '';
  assert.match(allowlist,/desktop-windows\/src\/windows-reminder-tasks\.mjs/);
  assert.match(allowlist,/desktop-windows\/src\/windows-reminder-tasks\.ps1/);
  assert.ok(taskManager.indexOf('atomicWrite(launchPath, launchText)') < taskManager.indexOf('atomicWrite(scriptPath, script)'),
    'Upgrade writes the new launch config before atomically replacing the helper used by already-registered tasks.');
  assert.match(taskManager,/reminder-launch\.v2\.conf[\s\S]*On an upgrade, keep the old JSON file[\s\S]*atomicWrite\(scriptPath, script\)/,
    'Upgrade leaves the legacy JSON config available to an old helper if the process stops before helper replacement.');
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
  const launchValueParser=taskHelper.match(/function ConvertFrom-LaunchConfigValue[\s\S]*?(?=\n}\n\nfunction Read-ReminderLaunchConfiguration)/)?.[0] ?? '';
  assert.match(deliveryFunction,/\[IO\.Path\]::Combine\(\$PSScriptRoot, 'reminder-launch\.v2\.conf'\)[\s\S]*\[IO\.File\]::Exists\(\$launchPath\)[\s\S]*Read-ReminderLaunchConfiguration \$launchPath \$DiagnosticPath[\s\S]*launch-config-parse-after/,
    'The trigger path reads and validates the versioned config through .NET APIs.');
  assert.match(deliveryFunction,/\$launch = Read-ReminderLaunchConfiguration \$launchPath \$DiagnosticPath[\s\S]*\$launchMode = \$launch\['mode'\][\s\S]*if \(\$launchMode -eq 'msix'\)[\s\S]*elseif \(\$launchMode -eq 'portable'/,
    'Delivery binds the validated mode in the caller scope before dispatching to the portable or MSIX launch path.');
  assert.match(launchParserFunction,/\[IO\.File\]::ReadAllBytes\(\$configPath\)[\s\S]*bytes\.Length -gt 65536[\s\S]*UTF8Encoding\]::new\(\$false, \$true\)[\s\S]*Dictionary\[string,string\][\s\S]*ContainsKey\(\$key\)[\s\S]*\$allowedKeys[\s\S]*-notin \$allowedKeys/,
    'The launch parser uses bounded strict UTF-8 and rejects duplicate or unknown fields without loading optional assemblies.');
  assert.match(launchValueParser,/FromBase64String\(\$value\)[\s\S]*ToBase64String\(\$bytes\) -cne \$value/);
  assert.match(launchParserFunction,/\$argumentCount -gt 16[\s\S]*\$argumentKey = 'argument\.' \+ \$index/,
    'The launch parser validates canonical base64 values and bounds portable arguments.');
  assert.doesNotMatch(launchParserFunction,/ConvertFrom-Json/,
    'Scheduled delivery does not invoke the slow PowerShell JSON cmdlet on the ARM cold path.');
  assert.match(launchParserFunction,/launch-config-read-before[\s\S]*launch-config-read-after[\s\S]*launch-config-schema-check-before[\s\S]*launch-config-schema-check-after/,
    'The scheduled smoke distinguishes config reading from schema validation.');
  assert.doesNotMatch(deliveryFunction,/\b(?:Join-Path|Test-Path|Get-Content|New-Item|Remove-Item)\b/,
    'Scheduled delivery does not invoke filesystem provider cmdlets on its cold PowerShell path.');
  assert.match(launchParserFunction,/\$launch\.Add\('diagnosticsFile', \$diagnosticsFile\)[\s\S]*\$launch\.Add\('waitForChildExit', \$waitForChildExit\)/,
    'The parser normalizes omitted production-only optional fields to safe defaults before delivery reads them.');
  assert.match(deliveryFunction,/\$diagnosticsFile = \[string\]\$launch\['diagnosticsFile'\][\s\S]*\$waitForChildExit = \$launch\['waitForChildExit'\] -eq \$true/,
    'StrictMode delivery reads only normalized optional properties rather than assuming source fields exist.');
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
  assert.match(workflow,/windows-reminder-task\.smoke\.mjs portable/,
    'The Windows package workflow exercises actual portable scheduled-task delivery.');
  assert.match(msixUpdate,/windows-reminder-task\.smoke\.mjs'\) 'msix'/,
    'The installed MSIX update test exercises actual scheduled-task delivery through its MSIX launch path.');
  assert.match(workflow,/\[System\.Management\.Automation\.Language\.Parser\]::ParseFile\([\s\S]*\$parseErrors\.Count/,
    'The early PowerShell preflight uses the PowerShell AST parser and fails on syntax errors.');
  const preflight=workflow.slice(workflow.indexOf('- name: Parse reminder helper'),workflow.indexOf('- name: Install pinned local Whisper browser runtime'));
  assert.doesNotMatch(preflight,/System\.Web\.Extensions|JavaScriptSerializer|ConvertFrom-Json/,
    'The early helper preflight does not depend on PowerShell JSON assemblies or cmdlets.');
  assert.match(preflight,/portable-production[\s\S]*portable-diagnostic[\s\S]*msix-production[\s\S]*msix-diagnostic[\s\S]*-ValidateLaunchConfig -LaunchConfigPath[\s\S]*Windows PowerShell 5\.1 rejected reminder config/,
    'Windows PowerShell 5.1 invokes the full helper validator for production and diagnostic portable/MSIX configs.');
  assert.match(preflight,/duplicate-key[\s\S]*unknown-key[\s\S]*invalid-base64[\s\S]*accepted invalid reminder config/,
    'Windows CI verifies malformed, duplicate and unknown config fields fail closed.');
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
