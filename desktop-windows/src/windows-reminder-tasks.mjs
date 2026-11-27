import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = /^[a-f0-9]{32}$/u;
const SCOPE = /^[a-f0-9]{64}$/u;
const sourceScript = fileURLToPath(new URL('./windows-reminder-tasks.ps1', import.meta.url));

function atomicWrite(filePath, bytes) {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temp, filePath);
  } finally { rmSync(temp, { force: true }); }
}

function encodeLaunchValue(value) { return Buffer.from(value, 'utf8').toString('base64'); }

/** Versioned key/value format for the Windows PowerShell 5.1 task helper. */
export function serializeReminderLaunchConfig(launch) {
  if (!launch || typeof launch !== 'object' || !['portable', 'msix'].includes(launch.mode)) {
    throw TypeError('Invalid reminder launch configuration');
  }
  const allowed = launch.mode === 'portable'
    ? new Set(['mode', 'executable', 'arguments', 'diagnosticsFile', 'waitForChildExit'])
    : new Set(['mode', 'diagnosticsFile']);
  if (Object.keys(launch).some(key => !allowed.has(key))) throw TypeError('Invalid reminder launch configuration');
  const lines = ['version=2', `mode=${launch.mode}`];
  if (launch.mode === 'portable') {
    if (typeof launch.executable !== 'string' || !path.isAbsolute(launch.executable) || launch.executable.length > 2048
      || !Array.isArray(launch.arguments) || launch.arguments.length > 16
      || launch.arguments.some(value => typeof value !== 'string' || value.length > 2048)
      || (launch.waitForChildExit !== undefined && typeof launch.waitForChildExit !== 'boolean')) {
      throw TypeError('Invalid reminder launch configuration');
    }
    lines.push(`executableB64=${encodeLaunchValue(launch.executable)}`);
    lines.push(`argumentCount=${launch.arguments.length}`);
    launch.arguments.forEach((value, index) => lines.push(`argument.${index}=${encodeLaunchValue(value)}`));
    if (launch.waitForChildExit !== undefined) lines.push(`waitForChildExit=${launch.waitForChildExit}`);
  }
  if (launch.diagnosticsFile !== undefined) {
    if (typeof launch.diagnosticsFile !== 'string' || !path.isAbsolute(launch.diagnosticsFile) || launch.diagnosticsFile.length > 2048) {
      throw TypeError('Invalid reminder launch configuration');
    }
    lines.push(`diagnosticsFileB64=${encodeLaunchValue(launch.diagnosticsFile)}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** Task Scheduler adapter. Only opaque reminder tokens and UTC times enter task definitions. */
export function createWindowsReminderTaskManager({ stateRoot, scope, windowsStore = false, executable, launchArguments = [],
  exec = execFileSync } = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || !SCOPE.test(scope)
    || typeof windowsStore !== 'boolean' || (!windowsStore && (typeof executable !== 'string' || !path.isAbsolute(executable)))
    || !Array.isArray(launchArguments) || launchArguments.some(value => typeof value !== 'string' || value.length > 2048)
    || typeof exec !== 'function') throw TypeError('Invalid Windows reminder task dependencies');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(stateRoot, 'meeting-reminder-task.ps1');
  const launchPath = path.join(stateRoot, 'reminder-launch.v2.conf');
  const triggerDir = path.join(stateRoot, 'reminder-triggers');
  const script = readFileSync(sourceScript);
  const launch = windowsStore ? { mode: 'msix' } : { mode: 'portable', executable, arguments: launchArguments };
  const launchText = serializeReminderLaunchConfig(launch);
  if (!existsSync(launchPath) || !readFileSync(launchPath).equals(launchText)) atomicWrite(launchPath, launchText);
  // On an upgrade, keep the old JSON file for the old helper until the new config is durable.
  // Replacing the helper last makes existing tasks observe either the old helper+JSON pair or the new helper+v2 pair.
  if (!existsSync(scriptPath) || !readFileSync(scriptPath).equals(script)) atomicWrite(scriptPath, script);

  function sync(records) {
    if (!Array.isArray(records) || records.length > 32 || records.some(record => !TOKEN.test(record?.token)
      || !Number.isFinite(Date.parse(record.start)) || !Number.isFinite(Date.parse(record.end))
      || Date.parse(record.end) <= Date.parse(record.start) || (record.retry !== undefined && typeof record.retry !== 'boolean')))
      throw TypeError('Invalid Windows reminder task plan');
    const planPath = path.join(stateRoot, `reminder-task-plan-${randomUUID()}.json`);
    atomicWrite(planPath, Buffer.from(JSON.stringify(records.map(({ token, start, retry, end }) => retry === true
      ? { token, start, retry: true, end } : { token, start, end }))));
    try {
      exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-Sync', '-PlanPath', planPath, '-Scope', scope], { windowsHide: true, timeout: 30_000, stdio: 'pipe' });
    } finally { rmSync(planPath, { force: true }); }
  }
  function pending() {
    if (!existsSync(triggerDir)) return [];
    const tokens = [];
    for (const entry of readdirSync(triggerDir)) {
      if (!/^[a-f0-9]{32}[.]trigger$/u.test(entry)) continue;
      const token = entry.slice(0, -'.trigger'.length);
      try { if (readFileSync(path.join(triggerDir, entry), 'utf8') === token) tokens.push(token); }
      catch { /* Leave unreadable markers for the next trigger scan. */ }
    }
    return tokens;
  }
  function clearPending(token) {
    if (TOKEN.test(token)) rmSync(path.join(triggerDir, `${token}.trigger`), { force: true });
  }
  return { sync, pending, clearPending, scriptPath, launchPath, triggerDir };
}

/** Encrypts event details at rest; Task Scheduler stores only random tokens and event times. */
export function createEncryptedReminderStore({ safeStorage, filePath } = {}) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()
    || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function'
    || typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw TypeError('Secure Windows reminder storage is unavailable');
  function load() {
    if (!existsSync(filePath)) return [];
    try {
      const value = JSON.parse(safeStorage.decryptString(readFileSync(filePath)));
      if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > 32) return [];
      return value.records;
    } catch { return []; }
  }
  function save(records) {
    const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, records }));
    atomicWrite(filePath, encrypted);
  }
  return { load, save };
}
