import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWindowsReminderTaskManager } from '../src/windows-reminder-tasks.mjs';

if (process.platform !== 'win32') throw Error('Windows Task Scheduler smoke requires Windows.');
const mode = process.argv[2];
if (!['portable', 'msix'].includes(mode)) throw Error('Select the portable or msix task launch mode.');
const scope = '7'.repeat(64), token = '8'.repeat(32);
const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'reel-reminder-task-'));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const receiver = path.join(stateRoot, 'receiver.ps1');
writeFileSync(receiver, `param([string]$Activation)\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'delivered.txt'), $Activation)\n`);
const manager = createWindowsReminderTaskManager({stateRoot, scope, windowsStore: mode === 'msix', executable: powershell,
  launchArguments: mode === 'portable' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', receiver] : []});
const command = (phase,script,timeout=15_000) => {
  console.log(`Windows reminder smoke: ${phase} (Node ${process.arch}).`);
  const started=Date.now();
  const output=execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {encoding:'utf8', windowsHide:true, timeout}).trim();
  console.log(`Windows reminder smoke: ${phase} completed in ${Date.now()-started} ms.`);
  return output;
};
const taskQuery = name => command('read scheduled task through Task Scheduler COM',
  `$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t=$s.GetFolder([string][char]92).GetTask('${name}'); `+
  `$p=$t.Definition.Principal; $principal=$p.UserId; $sid=$principal; `+
  `if ($sid -notmatch '^S-1-') { $account=$principal; if ($account -notmatch '\\\\') { $account=$env:USERDOMAIN+'\\'+$account }; `+
  `$sid=([Security.Principal.NTAccount]::new($account).Translate([Security.Principal.SecurityIdentifier])).Value }; `+
  `$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `+
  `[pscustomobject]@{name=$t.Name;user=$principal;userSid=$sid;currentSid=$current} | ConvertTo-Json -Compress`);
const taskSecurity = name => {
  console.log('Windows reminder smoke: read task security from registered task XML.');
  const started=Date.now(), schtasks=path.join(process.env.SystemRoot || 'C:\\Windows','System32','schtasks.exe');
  const xml=execFileSync(schtasks,['/Query','/TN',name,'/XML'],{encoding:'utf8',windowsHide:true,timeout:15_000});
  const readTag=tag=>xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`,'i'))?.[1] ?? '<missing>';
  console.log(`Windows reminder smoke: task XML query completed in ${Date.now()-started} ms.`);
  return {logonType:readTag('LogonType'),runLevel:readTag('RunLevel'),args:readTag('Arguments'),start:readTag('StartBoundary')};
};
const taskCount = () => Number(command('count this scope’s scheduled tasks through Task Scheduler COM',
  `$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $f=$s.GetFolder([string][char]92); $count=0; `+
  `foreach($task in @($f.GetTasks(0))) { if($task.Name.StartsWith('ReelReminder_${scope}_',[StringComparison]::Ordinal)) { $count++ } }; $count`));
let completed = false;
try {
  const runtime=JSON.parse(command('inspect Task Scheduler PowerShell host',
    `[pscustomobject]@{path=(Get-Process -Id $PID).Path;architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString();is64Bit=[Environment]::Is64BitProcess;user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress`,30_000));
  assert.equal(runtime.is64Bit,true,'Task Scheduler COM is queried from a 64-bit PowerShell host.');
  console.log(`Task Scheduler PowerShell host: ${JSON.stringify(runtime)}`);
  const sidHash=createHash('sha256').update(runtime.sid,'utf8').digest('hex');
  const taskName='ReelReminder_'+scope+'_'+sidHash+'_'+token;
  const taskStart=new Date(Date.now()+5*60_000).toISOString();
  const taskEnd=new Date(Date.parse(taskStart)+30*60_000).toISOString();
  const taskBoundary=Math.ceil(Date.parse(taskStart)/1000)*1000;
  console.log('Windows reminder smoke: register current-user task.');
  manager.sync([{token,start:taskStart,end:taskEnd}]);
  console.log('Windows reminder smoke: Task Scheduler registration returned.');
  let info = taskQuery(taskName);
  const security=taskSecurity(taskName);
  console.log(`Sanitized task principal: ${JSON.stringify({user:info.user,userSid:info.userSid,currentSid:info.currentSid,...security})}`);
  assert.equal(info.userSid, info.currentSid, `Task principal ${info.user} resolves to the current Windows user SID.`);
  assert.equal(security.logonType,'InteractiveToken','The task uses TASK_LOGON_INTERACTIVE_TOKEN and stores no password.');
  // Task Scheduler omits the optional XML RunLevel element when LUA is the default; an elevated task serializes HighestAvailable.
  assert.ok(['<missing>','LeastPrivilege'].includes(security.runLevel),
    'The task uses least privilege; Task Scheduler omits RunLevel from its XML when its least-privilege default applies.');
  assert.match(security.args, new RegExp(token),'The registered task action carries its opaque meeting token.');
  assert.equal(Date.parse(security.start),taskBoundary,'Task Scheduler start time is rounded up to the next whole second, never earlier than the meeting.');
  assert.ok(!security.args.includes('private calendar title') && !security.args.includes('private-event-id'));
  const retryEnd=new Date(Date.now()+60_000).toISOString();
  const alreadyDueRetry=new Date(Date.now()-10_000).toISOString();
  manager.sync([{token,start:alreadyDueRetry,retry:true,end:retryEnd}]);
  console.log('Windows reminder smoke: retry task update returned.');
  const retried=taskQuery(taskName);
  const retriedSecurity=taskSecurity(taskName);
  assert.equal(retried.name,taskName,'Rearming replaces the existing one-shot task instead of leaving a consumed task.');
  assert.ok(Date.parse(retriedSecurity.start)>Date.now()+10_000,'A retry already due when PowerShell processes it is moved safely into the future.');
  assert.ok(Date.parse(retriedSecurity.start)<Date.parse(retryEnd),'A retry is never moved beyond the meeting end.');
  command('run registered task through Task Scheduler COM',
    `$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t=$s.GetFolder([string][char]92).GetTask('${info.name}'); $null=$t.Run($null)`);
  const deadline = Date.now()+15_000;
  while (Date.now()<deadline) {
    if (mode==='portable') {
      try { if (readFileSync(path.join(stateRoot,'delivered.txt'),'utf8')===`--meeting-reminder-trigger=${token}`) { completed=true;break; } }
      catch { /* The task may not have launched yet. */ }
    }
    if (mode==='msix' && manager.pending().includes(token)) { completed=true;break; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(completed,true,'The registered task runs its trigger action.');
  manager.sync([{token,start:new Date(Date.now()-10_000).toISOString(),retry:true,end:new Date(Date.now()+2_000).toISOString()}]);
  assert.equal(taskCount(),0,'No retry task remains when its safe delay would reach the meeting end.');
  const delayedSyncEnd=new Date(Date.now()+60_000).toISOString();
  manager.sync([{token,start:new Date(Date.now()-1_000).toISOString(),end:delayedSyncEnd}]);
  const delayedTask=taskQuery(taskName), delayedSecurity=taskSecurity(taskName);
  assert.equal(delayedTask.name,taskName,'A regular meeting task is re-armed if sync finishes after its start boundary.');
  assert.ok(Date.parse(delayedSecurity.start)>Date.now()+10_000,'A delayed sync moves an already-due start to a safe future boundary.');
  assert.ok(Date.parse(delayedSecurity.start)<Date.parse(delayedSyncEnd),'A delayed sync does not schedule past the meeting end.');
  const endBoundary=Math.ceil((Date.now()+60_001)/1000)*1000;
  manager.sync([{token,start:new Date(endBoundary-1).toISOString(),end:new Date(endBoundary).toISOString()}]);
  assert.equal(taskCount(),0,'Rounding a fractional start to the next second removes a reminder that would start at its meeting end.');
  if (mode==='msix') {
    assert.match(readFileSync(manager.launchPath,'utf8'),/"mode":"msix"/);
    assert.ok(command('resolve installed MSIX identity',"Get-AppxPackage -Name 'RocketShipHQ.Reel' | Select-Object -First 1 -ExpandProperty PackageFamilyName"),
      'The MSIX launch resolver finds the currently installed package family.');
  }
  manager.sync([]);
  assert.equal(taskCount(),0,'Opt-out cleanup removes the per-user reminder task.');
  console.log(`Windows Task Scheduler ${mode} registration/run/delete passed.`);
} finally {
  try { manager.sync([]); } catch { /* Preserve the original smoke failure while attempting task cleanup. */ }
  rmSync(stateRoot,{recursive:true,force:true});
}
