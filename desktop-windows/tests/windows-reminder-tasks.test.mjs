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
    assert.equal(JSON.parse(readFileSync(manager.launchPath,'utf8')).executable,executable);
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
  const smoke=readFileSync(path.join(root,'tests','windows-reminder-task.smoke.mjs'),'utf8');
  const allowlist=build.match(/\$productFiles\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? '';
  assert.match(allowlist,/desktop-windows\/src\/windows-reminder-tasks\.mjs/);
  assert.match(allowlist,/desktop-windows\/src\/windows-reminder-tasks\.ps1/);
  const taskHelper=readFileSync(path.join(root,'src','windows-reminder-tasks.ps1'),'utf8');
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
  assert.match(smoke,/lastTaskResult=\[uint32\]\$t\.LastTaskResult[\s\S]*principalMatchesCurrent[\s\S]*logonType=/,
    'The Windows smoke reports the real registered action result and verifies its current-user interactive principal.');
  assert.match(smoke,/\$null=\$t\.Run\(\$null\)[\s\S]*lastTaskResult,0/,
    'The Windows smoke runs the registered task and checks its action result.');
  assert.match(smoke,/receiver\.mjs[\s\S]*process\.argv\.find\(argument => \/\^--meeting-reminder-trigger=/,
    'The portable task smoke receiver accepts the same argv trigger flag as the Electron app.');
  assert.doesNotMatch(smoke,/\b(?:info|retried|delayedTask)\.name\b/,
    'The smoke does not depend on COM properties that PowerShell JSON serialization omits.');
  assert.match(smoke,/const delayedInfo=taskQuery\(taskName\), delayedSecurity=taskSecurity\(taskName\)[\s\S]*delayedSecurity\.name,taskName/,
    'Delayed registration is verified through an exact-name scheduler XML query.');
  assert.match(taskHelper,/\.Principal\.LogonType\s*=\s*3/);
  assert.match(taskHelper,/\.Principal\.RunLevel\s*=\s*0/,
    'Tasks must use the current interactive token at the least-privileged run level.');
  assert.match(taskHelper,/\[int\]\$exception\.HResult\)\.ToString\('X8'\)[\s\S]*Reminder task diagnostic: exception=.*hresult=.*line=/,
    'The Windows smoke can report negative HRESULTs safely with sanitized exception type and source line.');
  assert.match(smoke,/manager\.sync\(\[\]\)[\s\S]*taskCount\(\),0[\s\S]*Opt-out cleanup removes/,
    'The Windows scheduler smoke exercises empty-plan deletion and verifies no task remains.');
  assert.match(msix,/<desktop:ToastNotificationActivation ToastActivatorCLSID="\$toastActivatorClsid" \/>/);
  assert.match(msix,/<com:Class Id="\$toastActivatorClsid" \/>/,
    'The MSIX manifest uses schema-valid unbraced GUID values for Electron toast activation.');
});
