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
  `$taskXml=[xml]$t.Xml; $principalNode=$taskXml.SelectSingleNode("//*[local-name()='Principal']"); `+
  `$userNode=$principalNode.SelectSingleNode("./*[local-name()='UserId']"); $principal=$userNode.InnerText; `+
  `$logonNode=$principalNode.SelectSingleNode("./*[local-name()='LogonType']"); `+
  `$runLevelNode=$principalNode.SelectSingleNode("./*[local-name()='RunLevel']"); `+
  `$logonType=if($null -eq $logonNode) { '<missing>' } else { $logonNode.InnerText }; `+
  `$runLevel=if($null -eq $runLevelNode) { '<missing>' } else { $runLevelNode.InnerText }; $sid=$principal; `+
  `if ($sid -notmatch '^S-1-') { $account=$principal; if ($account -notmatch '\\\\') { $account=$env:USERDOMAIN+'\\'+$account }; `+
  `$sid=([Security.Principal.NTAccount]::new($account).Translate([Security.Principal.SecurityIdentifier])).Value }; `+
  `$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `+
  `[pscustomobject]@{name=$t.Name;user=$principal;userSid=$sid;currentSid=$current;logonType=$logonType;runLevel=$runLevel;args=$t.Definition.Actions.Item(1).Arguments;start=$t.Definition.Triggers.Item(1).StartBoundary} | ConvertTo-Json -Compress`);
const taskCount = () => Number(command('count this scope’s scheduled tasks through Task Scheduler COM',
  `$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $f=$s.GetFolder([string][char]92); $count=0; `+
  `foreach($task in @($f.GetTasks(0))) { if($task.Name.StartsWith('ReelReminder_${scope}_',[StringComparison]::Ordinal)) { $count++ } }; $count`));
let completed = false;
try {
  const runtime=JSON.parse(command('inspect Task Scheduler PowerShell host',
    `[pscustomobject]@{path=(Get-Process -Id $PID).Path;architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString();is64Bit=[Environment]::Is64BitProcess;user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress`,10_000));
  assert.equal(runtime.is64Bit,true,'Task Scheduler COM is queried from a 64-bit PowerShell host.');
  console.log(`Task Scheduler PowerShell host: ${JSON.stringify(runtime)}`);
  const currentSid=command('resolve current user SID','[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',10_000);
  const sidHash=createHash('sha256').update(currentSid,'utf8').digest('hex');
  const taskName='ReelReminder_'+scope+'_'+sidHash+'_'+token;
  const taskStart=new Date(Date.now()+5*60_000).toISOString();
  console.log('Windows reminder smoke: register current-user task.');
  manager.sync([{token,start:taskStart}]);
  console.log('Windows reminder smoke: Task Scheduler registration returned.');
  let info = taskQuery(taskName);
  console.log(`Sanitized task principal: ${JSON.stringify({user:info.user,userSid:info.userSid,currentSid:info.currentSid,logonType:info.logonType,runLevel:info.runLevel})}`);
  assert.equal(info.userSid, info.currentSid, `Task principal ${info.user} resolves to the current Windows user SID.`);
  assert.equal(info.logonType,'InteractiveToken','The task uses TASK_LOGON_INTERACTIVE_TOKEN and stores no password.');
  assert.equal(info.runLevel,'LeastPrivilege','The task runs at the current user’s least-privileged run level.');
  assert.match(info.args, new RegExp(token));
  assert.equal(Date.parse(info.start),Date.parse(taskStart),'Task Scheduler preserves the event time down to the millisecond.');
  assert.ok(!info.args.includes('private calendar title') && !info.args.includes('private-event-id'));
  const retryEnd=new Date(Date.now()+60_000).toISOString();
  const alreadyDueRetry=new Date(Date.now()-10_000).toISOString();
  manager.sync([{token,start:alreadyDueRetry,retry:true,end:retryEnd}]);
  console.log('Windows reminder smoke: retry task update returned.');
  const retried=taskQuery(taskName);
  assert.equal(retried.name,taskName,'Rearming replaces the existing one-shot task instead of leaving a consumed task.');
  info=retried;
  assert.ok(Date.parse(info.start)>Date.now()+10_000,'A retry already due when PowerShell processes it is moved safely into the future.');
  assert.ok(Date.parse(info.start)<Date.parse(retryEnd),'A retry is never moved beyond the meeting end.');
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
