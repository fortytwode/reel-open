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

/** Task Scheduler adapter. Only opaque reminder tokens and UTC times enter task definitions. */
export function createWindowsReminderTaskManager({ stateRoot, scope, windowsStore = false, executable, launchArguments = [],
  exec = execFileSync } = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || !SCOPE.test(scope)
    || typeof windowsStore !== 'boolean' || (!windowsStore && (typeof executable !== 'string' || !path.isAbsolute(executable)))
    || !Array.isArray(launchArguments) || launchArguments.some(value => typeof value !== 'string' || value.length > 2048)
    || typeof exec !== 'function') throw TypeError('Invalid Windows reminder task dependencies');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(stateRoot, 'meeting-reminder-task.ps1');
  const launchPath = path.join(stateRoot, 'reminder-launch.json');
  const triggerDir = path.join(stateRoot, 'reminder-triggers');
  const script = readFileSync(sourceScript);
  if (!existsSync(scriptPath) || !readFileSync(scriptPath).equals(script)) atomicWrite(scriptPath, script);
  const launch = windowsStore ? { mode: 'msix' } : { mode: 'portable', executable, arguments: launchArguments };
  const launchText = Buffer.from(JSON.stringify(launch));
  if (!existsSync(launchPath) || !readFileSync(launchPath).equals(launchText)) atomicWrite(launchPath, launchText);

  function sync(records) {
    if (!Array.isArray(records) || records.length > 32 || records.some(record => !TOKEN.test(record?.token)
      || !Number.isFinite(Date.parse(record.start)) || (record.retry !== undefined && typeof record.retry !== 'boolean')
      || (record.end !== undefined && (!Number.isFinite(Date.parse(record.end)) || Date.parse(record.end) <= Date.parse(record.start)))
      || (record.retry === true && record.end === undefined)))
      throw TypeError('Invalid Windows reminder task plan');
    const planPath = path.join(stateRoot, `reminder-task-plan-${randomUUID()}.json`);
    atomicWrite(planPath, Buffer.from(JSON.stringify(records.map(({ token, start, retry, end }) => retry === true
      ? { token, start, retry: true, end } : end === undefined ? { token, start } : { token, start, end }))));
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
