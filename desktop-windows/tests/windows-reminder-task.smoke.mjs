import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWindowsReminderTaskManager, serializeReminderLaunchConfig } from '../src/windows-reminder-tasks.mjs';

if (process.platform !== 'win32') throw Error('Windows Task Scheduler smoke requires Windows.');
const mode = process.argv[2];
if (!['portable', 'msix'].includes(mode)) throw Error('Select the portable or msix task launch mode.');
const scope = '7'.repeat(64), token = '8'.repeat(32);
const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'reel-reminder-task-'));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const receiverApp = path.join(stateRoot, 'receiver-app');
const receiver = path.join(receiverApp, 'receiver.mjs');
const smokeExecutable = process.env.REEL_REMINDER_SMOKE_ELECTRON || process.execPath;
mkdirSync(receiverApp, { recursive: true });
writeFileSync(path.join(receiverApp, 'package.json'), JSON.stringify({ type: 'module', main: 'receiver.mjs' }));
writeFileSync(receiver, `import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const stateRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const diagnostics = join(stateRoot, 'scheduler-milestones.log');
appendFileSync(diagnostics, 'receiver-started\\n');
appendFileSync(diagnostics, 'receiver-started-at:' + Date.now() + '\\n');
const activation = process.argv.find(argument => /^--meeting-reminder-trigger=[a-f0-9]{32}$/.test(argument));
if (activation) {
  writeFileSync(join(stateRoot, 'delivered.txt'), activation);
  appendFileSync(diagnostics, 'receiver-trigger-accepted\\n');
}
appendFileSync(diagnostics, 'receiver-exited:0\\n');
appendFileSync(diagnostics, 'receiver-exited-at:' + Date.now() + '\\n');
process.exit(0);
`);
const productionLaunchConfig = mode === 'msix'
  ? { mode: 'msix' }
  : { mode: 'portable', executable: smokeExecutable, arguments: [receiverApp] };
let lastSyncSummary = null;
const manager = createWindowsReminderTaskManager({stateRoot, scope, windowsStore: mode === 'msix', executable: smokeExecutable,
  launchArguments: mode === 'portable' ? [receiverApp] : [],
  exec:(file,args,options)=>{
    const planPath=args[args.indexOf('-PlanPath')+1];
    const plan=JSON.parse(readFileSync(planPath,'utf8'));
    assert.ok(plan.every(item=>Number.isFinite(Date.parse(item.start))&&Number.isFinite(Date.parse(item.end))
      &&Date.parse(item.end)>Date.parse(item.start)),'Task manager serialized UTC start/end for every reminder.');
    console.log(`Task plan UTC bounds (ms): ${JSON.stringify(plan.map(item=>({start:Date.parse(item.start),end:Date.parse(item.end)})))}`);
    const output=execFileSync(file,[...args,'-Diagnostic'],options);
    lastSyncSummary=JSON.parse(output.toString('utf8').trim());
    console.log(`Windows reminder sync summary: ${JSON.stringify(lastSyncSummary)}`);
    return output;
  }});
const diagnosticsFile=path.join(stateRoot,'scheduler-milestones.log');
const launchConfig={...productionLaunchConfig};
assert.equal(Object.hasOwn(productionLaunchConfig,'diagnosticsFile'),false,'The manager generated production config has no smoke diagnostic path.');
assert.equal(Object.hasOwn(productionLaunchConfig,'waitForChildExit'),false,'The manager generated production config has no smoke child wait flag.');
launchConfig.diagnosticsFile=diagnosticsFile;
if(mode==='portable') launchConfig.waitForChildExit=true;
writeFileSync(manager.launchPath,serializeReminderLaunchConfig(launchConfig));
const syncCounts = () => { const {timing,...counts}=lastSyncSummary ?? {}; return counts; };
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
  `[pscustomobject]@{user=$principal;userSid=$sid;currentSid=$current} | ConvertTo-Json -Compress`);
const taskSecurity = name => {
  console.log('Windows reminder smoke: read task security from registered task XML.');
  const started=Date.now(), schtasks=path.join(process.env.SystemRoot || 'C:\\Windows','System32','schtasks.exe');
  const xml=execFileSync(schtasks,['/Query','/TN',name,'/XML'],{encoding:'utf8',windowsHide:true,timeout:15_000});
  const readTag=tag=>xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`,'i'))?.[1] ?? '<missing>';
  console.log(`Windows reminder smoke: task XML query completed in ${Date.now()-started} ms.`);
  return {name,command:readTag('Command'),logonType:readTag('LogonType'),runLevel:readTag('RunLevel'),args:readTag('Arguments'),start:readTag('StartBoundary')};
};
const taskCount = () => Number(command('count this scope’s scheduled tasks through Task Scheduler COM',
  `$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $f=$s.GetFolder([string][char]92); $count=0; `+
  `foreach($task in @($f.GetTasks(0))) { if($task.Name.StartsWith('ReelReminder_${scope}_',[StringComparison]::Ordinal)) { $count++ } }; $count`));
const taskStatus = name => JSON.parse(command('read task action result and registered principal',
  `$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t=$s.GetFolder([string][char]92).GetTask('${name}'); `+
  `$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=[string]$t.Definition.Principal.UserId; $taskSid=$principal; `+
  `if (-not $taskSid.StartsWith('S-1-')) { $account=$principal; if (-not $principal.Contains([string][char]92)) { $account=$env:USERDOMAIN+[char]92+$principal }; `+
  `$taskSid=([Security.Principal.NTAccount]::new($account).Translate([Security.Principal.SecurityIdentifier])).Value }; `+
  `[pscustomobject]@{state=[int]$t.State;lastTaskResult=[int]$t.LastTaskResult;lastRunUtc=$t.LastRunTime.ToUniversalTime().ToString('o'); `+
  `principalMatchesCurrent=($taskSid -eq $identity.User.Value);logonType=[int]$t.Definition.Principal.LogonType; `+
  `sessionId=(Get-Process -Id $PID).SessionId;sessionName=$env:SESSIONNAME} | ConvertTo-Json -Compress`));
const taskLaunchDiagnostics = (name, scriptName='meeting-reminder-task[.]ps1') => JSON.parse(command('inspect task launch process and scheduler events',
  `$sessionId=(Get-Process -Id $PID).SessionId; $allProcesses=@(Get-CimInstance Win32_Process); `+
  `$processes=@($allProcesses | Where-Object { $_.CommandLine -match '${scriptName}' } | ForEach-Object { `+
  `$process=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.ParentProcessId) -ErrorAction SilentlyContinue; `+
  `[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;exe=[IO.Path]::GetFileName([string]$_.ExecutablePath); `+
  `parentExe=[IO.Path]::GetFileName([string]$parent.ExecutablePath);sessionId=[int]$_.SessionId; `+
  `elapsedMs=[int]((Get-Date).ToUniversalTime()-$_.CreationDate.ToUniversalTime()).TotalMilliseconds; `+
  `cpuSeconds=[math]::Round([double]$process.CPU,1);workingSetMB=[math]::Round([double]$process.WorkingSet64/1MB,1)} }); `+
  `$relatedSessionProcesses=@($allProcesses | Where-Object { $_.SessionId -eq $sessionId -and `+
  `[IO.Path]::GetFileName([string]$_.ExecutablePath) -match '^(powershell|node|electron|Reel)\.exe$' } | ForEach-Object { `+
    `$process=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; `+
    `[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;exe=[IO.Path]::GetFileName([string]$_.ExecutablePath); `+
    `elapsedMs=[int]((Get-Date).ToUniversalTime()-$_.CreationDate.ToUniversalTime()).TotalMilliseconds; `+
    `cpuSeconds=[math]::Round([double]$process.CPU,1);workingSetMB=[math]::Round([double]$process.WorkingSet64/1MB,1)} }); `+
  `$events=@(); try { $events=@(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational';StartTime=(Get-Date).AddMinutes(-3)} -ErrorAction Stop | `+
  `Where-Object { $_.Message -like ('*'+ '${name}' + '*') } | Select-Object -First 20 | ForEach-Object { `+
  `[pscustomobject]@{id=[int]$_.Id;timeUtc=$_.TimeCreated.ToUniversalTime().ToString('o');level=[int]$_.Level} }) } catch { }; `+
  `[pscustomobject]@{taskActionExe='${powershell.replaceAll("'", "''")}';matchedProcesses=$processes;relatedSessionProcesses=$relatedSessionProcesses;recentSchedulerEvents=$events} | ConvertTo-Json -Compress -Depth 4`,12_000));
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const runPowerShellStartupProbe = runtime => {
  const taskName = `ReelReminderStartupProbe_${randomUUID().replaceAll('-', '')}`;
  const scriptPath = path.join(stateRoot, 'scheduler-startup-probe.ps1');
  const markerPath = path.join(stateRoot, 'scheduler-startup-probe.txt');
  const requestedPath = path.join(stateRoot, 'scheduler-startup-requested.txt');
  writeFileSync(scriptPath,
    `[IO.File]::AppendAllText(${psQuote(markerPath)}, 'entry|' + [DateTime]::UtcNow.ToString('o') + [Environment]::NewLine)\r\n`+
    `[IO.File]::AppendAllText(${psQuote(markerPath)}, 'complete|' + [DateTime]::UtcNow.ToString('o') + [Environment]::NewLine)\r\n`);
  const actionArguments = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath.replaceAll('"', '\\"')}"`;
  const setup = `$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $folder=$service.GetFolder([string][char]92); `+
    `$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $task=$service.NewTask(0); `+
    `$task.Principal.UserId=$identity.User.Value; $task.Principal.LogonType=3; $task.Principal.RunLevel=0; `+
    `$task.Settings.Enabled=$true; $task.Settings.StartWhenAvailable=$true; $task.Settings.ExecutionTimeLimit='PT2M'; `+
    `$trigger=$task.Triggers.Create(1); $trigger.StartBoundary=[DateTime]::UtcNow.AddMinutes(5).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"); `+
    `$action=$task.Actions.Create(0); $action.Path=${psQuote(powershell)}; $action.Arguments=${psQuote(actionArguments)}; `+
    `$null=$folder.RegisterTaskDefinition(${psQuote(taskName)},$task,6,$identity.Name,$null,3,$null); `+
    `[IO.File]::WriteAllText(${psQuote(requestedPath)},[DateTime]::UtcNow.ToString('o')); `+
    `$null=$folder.GetTask(${psQuote(taskName)}).Run($null)`;
  console.log('Windows reminder smoke: measure scheduled PowerShell cold-start with a no-op action.');
  execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(setup,'utf16le').toString('base64')],
    {windowsHide:true,timeout:30_000,stdio:'pipe'});
  const requestedAt=Date.parse(readFileSync(requestedPath,'utf8'));
  const waitForLines = async (timeoutMs, count) => {
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline) {
      let lines=[];
      try { lines=readFileSync(markerPath,'utf8').trim().split(/\r?\n/); } catch { /* The scheduled process may not have reached script entry. */ }
      if(lines.length>=count) return lines;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    return [];
  };
  return (async()=>{
    try {
      const entryLines=await waitForLines(45_000,1);
      if(entryLines.length<1) {
        console.log(`Sanitized PowerShell startup-probe launch diagnostics: ${JSON.stringify(taskLaunchDiagnostics(taskName,'scheduler-startup-probe[.]ps1'))}`);
        throw Error('The scheduled PowerShell no-op did not reach its script entry within 45 seconds.');
      }
      const completeLines=entryLines.length>=2?entryLines:await waitForLines(10_000,2);
      assert.ok(completeLines.length>=2,'The scheduled PowerShell no-op action completed within 10 seconds after script entry.');
      const entryAt=Date.parse(entryLines[0].slice('entry|'.length));
      const completeAt=Date.parse(completeLines[1].slice('complete|'.length));
      const status=taskStatus(taskName);
      assert.notEqual(status.state,4,'The scheduled PowerShell no-op task has completed.');
      assert.equal(status.lastTaskResult,0,'The scheduled PowerShell no-op task exited successfully.');
      assert.equal(status.principalMatchesCurrent,true,'The startup probe uses the current Windows user SID.');
      assert.equal(status.logonType,3,'The startup probe uses an interactive token.');
      assert.equal(status.sessionId,runtime.sessionId,'The startup probe stays in the current interactive session.');
      const timing={entryMs:entryAt-requestedAt,completionMs:completeAt-requestedAt,actionMs:completeAt-entryAt};
      console.log(`Sanitized scheduled PowerShell startup timing: ${JSON.stringify(timing)}`);
      return timing;
    } finally {
      try {
        const deleteTask=`$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$f=$s.GetFolder([string][char]92);`+
          `try{$t=$f.GetTask(${psQuote(taskName)});$t.Stop(0)}catch{};$f.DeleteTask(${psQuote(taskName)},0)`;
        execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(deleteTask,'utf16le').toString('base64')],
          {windowsHide:true,timeout:10_000,stdio:'pipe'});
      } catch { /* Best-effort removal of the unique smoke-only task. */ }
    }
  })();
};
let completed = false;
try {
  const runtime=JSON.parse(command('inspect Task Scheduler PowerShell host',
    `[pscustomobject]@{path=(Get-Process -Id $PID).Path;architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString();is64Bit=[Environment]::Is64BitProcess;user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;sessionId=(Get-Process -Id $PID).SessionId;sessionName=$env:SESSIONNAME} | ConvertTo-Json -Compress`,30_000));
  assert.equal(runtime.is64Bit,true,'Task Scheduler COM is queried from a 64-bit PowerShell host.');
  console.log(`Task Scheduler host: ${JSON.stringify({architecture:runtime.architecture,is64Bit:runtime.is64Bit,sessionId:runtime.sessionId,sessionName:runtime.sessionName})}`);
  console.log(`Windows reminder smoke: portable child runtime is ${path.basename(smokeExecutable)} (${process.env.REEL_REMINDER_SMOKE_ELECTRON ? 'Electron' : 'Node fallback'}).`);
  const startupTiming=await runPowerShellStartupProbe(runtime);
  const taskWaitMs=60_000;
  console.log(`Windows reminder smoke: task action completion bound is ${taskWaitMs} ms; PowerShell startup probe took ${startupTiming.entryMs} ms.`);
  const sidHash=createHash('sha256').update(runtime.sid,'utf8').digest('hex');
  const taskName='ReelReminder_'+scope+'_'+sidHash+'_'+token;
  const taskStart=new Date(Date.now()+5*60_000).toISOString();
  const taskEnd=new Date(Date.parse(taskStart)+30*60_000).toISOString();
  assert.ok(Date.parse(taskEnd)>Date.now(),'The task fixture meeting end is in the future.');
  const taskBoundary=Math.ceil(Date.parse(taskStart)/1000)*1000;
  console.log('Windows reminder smoke: register current-user task.');
  manager.sync([{token,start:taskStart,end:taskEnd}]);
  console.log('Windows reminder smoke: Task Scheduler registration returned.');
  assert.deepEqual(syncCounts(),{registered:1,rearmed:0,skippedAtEnd:0,skippedPast:0},
    'The helper reports that its eligible task was registered.');
  assert.equal(lastSyncSummary.timing?.[0]?.planEndUtcMs,Date.parse(taskEnd),
    'PowerShell preserved the task fixture end instant exactly.');
  let info = taskQuery(taskName);
  const security=taskSecurity(taskName);
  console.log(`Sanitized task registration: ${JSON.stringify({principalMatchesCurrent:info.userSid===info.currentSid,logonType:security.logonType,runLevel:security.runLevel,start:security.start})}`);
  assert.equal(security.name,taskName,'The exact-name schtasks XML query confirms the task exists.');
  assert.match(path.basename(security.command).toLowerCase(),/^powershell(?:\.exe)?$/,
    'The registered action launches Windows PowerShell from the expected executable path.');
  assert.equal(info.userSid, info.currentSid, `Task principal ${info.user} resolves to the current Windows user SID.`);
  assert.equal(security.logonType,'InteractiveToken','The task uses TASK_LOGON_INTERACTIVE_TOKEN and stores no password.');
  // Task Scheduler omits the optional XML RunLevel element when LUA is the default; an elevated task serializes HighestAvailable.
  assert.ok(['<missing>','LeastPrivilege'].includes(security.runLevel),
    'The task uses least privilege; Task Scheduler omits RunLevel from its XML when its least-privilege default applies.');
  assert.match(security.args, new RegExp(token),'The registered task action carries its opaque meeting token.');
  assert.equal(Date.parse(security.start),taskBoundary,'Task Scheduler start time is rounded up to the next whole second, never earlier than the meeting.');
  assert.ok(!security.args.includes('private calendar title') && !security.args.includes('private-event-id'));
  // Exercise the real registered action while its initial trigger is safely far in the future.
  // ARM64 CI can take long enough to run the action that a due-retry trigger would overlap it.
  const taskActionRequestedAt=Date.now();
  command('run registered task through Task Scheduler COM',
    `$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t=$s.GetFolder([string][char]92).GetTask('${taskName}'); $null=$t.Run($null)`);
  const immediateStatus=taskStatus(taskName);
  let finalStatus=immediateStatus;
  console.log(`Sanitized scheduler action status immediately after Run: ${JSON.stringify(immediateStatus)}`);
  const deadline = Date.now()+taskWaitMs;
  const hasDeliveredTrigger = () => {
    if (mode==='portable') {
      try { return readFileSync(path.join(stateRoot,'delivered.txt'),'utf8')===`--meeting-reminder-trigger=${token}`; }
      catch { return false; }
    }
    return manager.pending().includes(token);
  };
  while (Date.now()<deadline) {
    completed=hasDeliveredTrigger();
    if (completed && finalStatus.state!==4 && finalStatus.lastTaskResult!==267009) break;
    await new Promise(resolve=>setTimeout(resolve,300));
    finalStatus=taskStatus(taskName);
  }
  completed=hasDeliveredTrigger();
  console.log(`Sanitized scheduler action status after trigger wait: ${JSON.stringify(finalStatus)}`);
  if (!completed || finalStatus.state===4 || finalStatus.lastTaskResult===267009) {
    console.log(`Sanitized scheduler launch diagnostics: ${JSON.stringify(taskLaunchDiagnostics(taskName))}`);
  }
  let launchMilestones=[];
  try { launchMilestones=readFileSync(diagnosticsFile,'utf8').trim().split(/\r?\n/).filter(Boolean); } catch { /* No helper milestone means the task did not reach config loading. */ }
  console.log(`Sanitized reminder launch milestones: ${JSON.stringify(launchMilestones)}`);
  const receiverStartedAt=Number(launchMilestones.find(value=>value.startsWith('receiver-started-at:'))?.slice('receiver-started-at:'.length));
  const receiverExitedAt=Number(launchMilestones.find(value=>value.startsWith('receiver-exited-at:'))?.slice('receiver-exited-at:'.length));
  console.log(`Windows reminder smoke: Electron/Node receiver launch took ${Number.isFinite(receiverStartedAt)?receiverStartedAt-taskActionRequestedAt:'unobserved'} ms; receiver execution took ${Number.isFinite(receiverExitedAt)&&Number.isFinite(receiverStartedAt)?receiverExitedAt-receiverStartedAt:'unobserved'} ms.`);
  assert.equal(completed,true,'The registered task runs its trigger action.');
  assert.notEqual(finalStatus.state,4,'Task Scheduler reports that the action has left the Running state.');
  assert.notEqual(finalStatus.lastTaskResult,267009,'The Scheduler running status has been replaced by the completed action result.');
  assert.equal(finalStatus.lastTaskResult,0,'The task trigger helper exits successfully in the current interactive session.');
  assert.equal(finalStatus.principalMatchesCurrent,true,'The registered trigger action principal is the current Windows user.');
  assert.equal(finalStatus.logonType,3,'The registered trigger action uses an interactive token.');
  assert.equal(finalStatus.sessionId,runtime.sessionId,'The task status probe is running in the same interactive Windows session as the smoke process.');
  assert.ok(launchMilestones.includes('helper-script-entry'),'The scheduled PowerShell process entered the reminder helper script.');
  assert.ok(launchMilestones.includes('helper-config-loaded'),'The task helper read its launch configuration.');
  assert.ok(launchMilestones.includes('trigger-marker-written'),'The task helper wrote its pending trigger marker.');
  if(mode==='portable') {
    for(const milestone of ['portable-start-process-called','portable-start-process-returned','receiver-started',
      'receiver-trigger-accepted','receiver-exited:0','portable-child-exited:0']) {
      assert.ok(launchMilestones.includes(milestone),`The portable trigger launch reached ${milestone}.`);
    }
  } else assert.ok(launchMilestones.includes('msix-shell-launch-returned'),'The MSIX shell activation was requested.');
  // Exercise the generated production config, which has neither smoke-only diagnostic field.
  // This catches StrictMode failures on absent optional JSON properties after trigger receipt.
  writeFileSync(manager.launchPath,serializeReminderLaunchConfig(productionLaunchConfig));
  const productionToken='9'.repeat(32);
  const productionTaskName='ReelReminder_'+scope+'_'+sidHash+'_'+productionToken;
  const productionStart=new Date(Date.now()+5*60_000).toISOString();
  const productionEnd=new Date(Date.parse(productionStart)+30*60_000).toISOString();
  manager.sync([{token:productionToken,start:productionStart,end:productionEnd}]);
  assert.deepEqual(syncCounts(),{registered:1,rearmed:0,skippedAtEnd:0,skippedPast:0},
    'The production-config task is eligible and registered.');
  const productionSecurity=taskSecurity(productionTaskName);
  const productionPrincipal=taskQuery(productionTaskName);
  assert.equal(productionSecurity.name,productionTaskName,'The production-config task exists by its exact name.');
  assert.equal(productionPrincipal.userSid,productionPrincipal.currentSid,'Production config remains bound to the current user.');
  assert.equal(productionSecurity.logonType,'InteractiveToken','Production config uses an interactive token.');
  console.log('Windows reminder smoke: run task with production launch config (no diagnostic fields).');
  command('run production-config reminder task through Task Scheduler COM',
    `$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$t=$s.GetFolder([string][char]92).GetTask('${productionTaskName}');$null=$t.Run($null)`);
  let productionStatus=taskStatus(productionTaskName);
  const productionDeadline=Date.now()+taskWaitMs;
  const productionDelivered=()=>mode==='portable'
    ? (()=>{try{return readFileSync(path.join(stateRoot,'delivered.txt'),'utf8')===`--meeting-reminder-trigger=${productionToken}`;}catch{return false;}})()
    : manager.pending().includes(productionToken);
  while(Date.now()<productionDeadline) {
    if(productionDelivered()&&productionStatus.state!==4&&productionStatus.lastTaskResult!==267009) break;
    await new Promise(resolve=>setTimeout(resolve,300));
    productionStatus=taskStatus(productionTaskName);
  }
  assert.equal(productionDelivered(),true,'The production launch configuration delivers the reminder trigger.');
  assert.notEqual(productionStatus.state,4,'The production-config task exits instead of remaining Running.');
  assert.equal(productionStatus.lastTaskResult,0,'The production-config task completes successfully without smoke-only fields.');
  const retryEnd=new Date(Date.now()+60_000).toISOString();
  const alreadyDueRetry=new Date(Date.now()-10_000).toISOString();
  console.log(`Retry fixture UTC milliseconds: ${JSON.stringify({start:Date.parse(alreadyDueRetry),end:Date.parse(retryEnd),created:Date.now()})}`);
  manager.sync([{token,start:alreadyDueRetry,retry:true,end:retryEnd}]);
  console.log('Windows reminder smoke: retry task update returned.');
  assert.deepEqual(syncCounts(),{registered:1,rearmed:1,skippedAtEnd:0,skippedPast:0},
    'The helper reports that the due retry was re-armed and registered.');
  const retryTiming=lastSyncSummary.timing?.[0];
  assert.equal(retryTiming?.decision,'registered');
  assert.equal(retryTiming.planEndUtcMs,Date.parse(retryEnd),'PowerShell preserved the retry end instant exactly.');
  assert.ok(retryTiming.planEndUtcMs-retryTiming.syncNowUtcMs>50_000,
    'The UTC event end survives PowerShell JSON parsing as a future bound.');
  assert.ok(retryTiming.candidateUtcMs>retryTiming.syncNowUtcMs+14_000
    && retryTiming.candidateUtcMs<retryTiming.planEndUtcMs,'The UTC retry candidate remains between the safe delay and meeting end.');
  const retried=taskQuery(taskName);
  const retriedSecurity=taskSecurity(taskName);
  assert.equal(retriedSecurity.name,taskName,'The exact-name schtasks XML query confirms the rearmed task exists.');
  assert.equal(taskCount(),1,'Rearming updates the existing one-shot task without leaving a duplicate.');
  assert.equal(retried.userSid,retried.currentSid,'The rearmed task still belongs to the current Windows user SID.');
  assert.equal(retriedSecurity.logonType,'InteractiveToken','The rearmed task still uses the current interactive token.');
  assert.ok(['<missing>','LeastPrivilege'].includes(retriedSecurity.runLevel),
    'The rearmed task remains at least-privileged.');
  assert.ok(Date.parse(retriedSecurity.start)>Date.now()+10_000,'A retry already due when PowerShell processes it is moved safely into the future.');
  assert.ok(Date.parse(retriedSecurity.start)<Date.parse(retryEnd),'A retry is never moved beyond the meeting end.');
  manager.sync([{token,start:new Date(Date.now()-10_000).toISOString(),retry:true,end:new Date(Date.now()+2_000).toISOString()}]);
  assert.deepEqual(syncCounts(),{registered:0,rearmed:1,skippedAtEnd:1,skippedPast:0},
    'The helper reports the retry was suppressed because its safe delay reached meeting end.');
  assert.equal(taskCount(),0,'No retry task remains when its safe delay would reach the meeting end.');
  const delayedSyncEnd=new Date(Date.now()+60_000).toISOString();
  manager.sync([{token,start:new Date(Date.now()-1_000).toISOString(),end:delayedSyncEnd}]);
  assert.deepEqual(syncCounts(),{registered:1,rearmed:1,skippedAtEnd:0,skippedPast:0},
    'The helper reports that a late regular sync was re-armed and registered.');
  const delayedInfo=taskQuery(taskName), delayedSecurity=taskSecurity(taskName);
  assert.equal(delayedSecurity.name,taskName,'The exact-name schtasks XML query confirms the delayed regular task exists.');
  assert.equal(delayedInfo.userSid,delayedInfo.currentSid,'The delayed task still belongs to the current user.');
  assert.ok(Date.parse(delayedSecurity.start)>Date.now()+10_000,'A delayed sync moves an already-due start to a safe future boundary.');
  assert.ok(Date.parse(delayedSecurity.start)<Date.parse(delayedSyncEnd),'A delayed sync does not schedule past the meeting end.');
  const endBoundary=Math.ceil((Date.now()+60_001)/1000)*1000;
  manager.sync([{token,start:new Date(endBoundary-1).toISOString(),end:new Date(endBoundary).toISOString()}]);
  assert.deepEqual(syncCounts(),{registered:0,rearmed:0,skippedAtEnd:1,skippedPast:0},
    'The helper reports that rounding would move the reminder to meeting end.');
  assert.equal(taskCount(),0,'Rounding a fractional start to the next second removes a reminder that would start at its meeting end.');
  if (mode==='msix') {
    assert.match(readFileSync(manager.launchPath,'utf8'),/^version=2\r?\nmode=msix\r?\n$/);
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
