import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const command = script => execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  {encoding:'utf8', windowsHide:true, timeout:20_000}).trim();
let completed = false;
try {
  manager.sync([{token,start:new Date(Date.now()+5*60_000).toISOString()}]);
  const taskJson = command(`$t=Get-ScheduledTask | Where-Object { $_.TaskName -like 'ReelReminder_${scope}_*' -and $_.Actions[0].Arguments.Contains('${token}') } | Select-Object -First 1; if (-not $t) { exit 2 }; [pscustomobject]@{ name=$t.TaskName; userSid=$t.Principal.UserId; logon=$t.Principal.LogonType.ToString(); args=$t.Actions[0].Arguments } | ConvertTo-Json -Compress`);
  const info = JSON.parse(taskJson);
  const currentSid = command('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  assert.equal(info.userSid, currentSid, 'The scheduled task is registered to the current Windows user SID.');
  assert.equal(info.logon, 'Interactive', 'The task uses the current interactive token and stores no password.');
  assert.match(info.args, new RegExp(token));
  assert.ok(!info.args.includes('private calendar title') && !info.args.includes('private-event-id'));
  command(`Start-ScheduledTask -TaskName '${info.name}'`);
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
  if (mode==='msix') {
    assert.match(readFileSync(manager.launchPath,'utf8'),/"mode":"msix"/);
    assert.ok(command("Get-AppxPackage -Name 'RocketShipHQ.Reel' | Select-Object -First 1 -ExpandProperty PackageFamilyName"),
      'The MSIX launch resolver finds the currently installed package family.');
  }
  manager.sync([]);
  const remaining=command(`@(Get-ScheduledTask | Where-Object { $_.TaskName -like 'ReelReminder_${scope}_*' }).Count`);
  assert.equal(Number(remaining),0,'Opt-out cleanup removes the per-user reminder task.');
  console.log(`Windows Task Scheduler ${mode} registration/run/delete passed.`);
} finally {
  try { manager.sync([]); } catch { /* Preserve the original smoke failure while attempting task cleanup. */ }
  rmSync(stateRoot,{recursive:true,force:true});
}
