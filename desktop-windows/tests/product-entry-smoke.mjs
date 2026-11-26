import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
  throw new Error('This smoke test runs only on a disposable GitHub Actions runner.');
}

const packageRoot = process.argv[2];
assert.ok(packageRoot, 'Pass the extracted portable package path.');
const executable = join(packageRoot, 'Reel.exe');
const organizationPath = join(packageRoot, 'resources', 'app', 'desktop-windows', 'organization.json');
assert.ok(existsSync(executable), 'The extracted packaged Reel.exe exists.');
assert.ok(existsSync(organizationPath), 'The packaged organization config exists.');

const edgeCandidates = [
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);
const edgePath = edgeCandidates.find(existsSync);
assert.ok(edgePath, 'A machine-installed Microsoft Edge is available.');

function powershell(script, env = process.env) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', env, timeout: 15000, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `PowerShell failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const inspectScript = String.raw`
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ReelSmokeWindows {
  public sealed class Window { public int pid; public string title; public string className; }
  private delegate bool Callback(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  public static Window[] Get() {
    var rows = new List<Window>();
    Callback callback = (hwnd, _) => {
      if (!IsWindowVisible(hwnd)) return true;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      var title = new StringBuilder(512); var cls = new StringBuilder(128);
      GetWindowText(hwnd, title, title.Capacity); GetClassName(hwnd, cls, cls.Capacity);
      if (title.Length > 0) rows.Add(new Window { pid = (int)pid, title = title.ToString(), className = cls.ToString() });
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return rows.ToArray();
  }
}
'@
Add-Type -TypeDefinition $code
$edges = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object {
  [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; path=$_.ExecutablePath; commandLine=$_.CommandLine }
})
$windows = @([ReelSmokeWindows]::Get())
[pscustomobject]@{ processes=$edges; windows=$windows } | ConvertTo-Json -Compress -Depth 4
`;

const signature = JSON.parse(powershell(String.raw`
$ErrorActionPreference = 'Stop'
$signature = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($env:REEL_SMOKE_EDGE_PATH)
$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
$chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
$valid = $chain.Build($signature)
[pscustomobject]@{ valid=$valid; signer=$signature.Subject } | ConvertTo-Json -Compress
`, { ...process.env, REEL_SMOKE_EDGE_PATH: edgePath }));
assert.equal(signature.valid, true, 'Edge has a valid Authenticode certificate chain.');
assert.match(signature.signer, /Microsoft Corporation/i, 'The signer is Microsoft.');

const apps = [
  { key: 'recorder', flag: '--open-recorder', path: '/record', title: 'Reel Recorder' },
  { key: 'notetaker', flag: '--open-notetaker', path: '/notetaker', title: 'Reel Notetaker' },
];
const reports = new Map();
let server;
let origin;
let testRoot;
let originalOrganization;
let createdPolicyKey = false;
let registrySet = false;
let baselineEdgePids = new Set();

async function listen() {
  server = createServer(async (request, response) => {
    if (request.headers.host !== origin.slice('http://'.length)) {
      response.writeHead(403).end(); return;
    }
    const pathname = new URL(request.url, origin).pathname;
    if (request.method === 'GET' && apps.some(app => app.path === pathname)) {
      const app = apps.find(item => item.path === pathname);
      const html = `<!doctype html><meta charset="utf-8"><title>${app.title}</title><h1>${app.title}</h1><script>
        const receipt={path:location.pathname,title:document.title,url:location.href,
          standalone:matchMedia('(display-mode: standalone)').matches,
          browser:matchMedia('(display-mode: browser)').matches};
        fetch('/__reel_smoke_report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(receipt)});
      </script>`;
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      }).end(html);
      return;
    }
    if (request.method === 'POST' && pathname === '/__reel_smoke_report'
        && request.headers.origin === origin) {
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 4096) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      try {
        const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const app = apps.find(item => item.path === receipt.path);
        if (!app || receipt.url !== origin + app.path || receipt.title !== app.title) throw Error('bad receipt');
        reports.set(app.key, receipt);
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
}

async function waitForReport(key, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = reports.get(key);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for synthetic ${key} app page report.`);
}

async function inspect() {
  const stdout = powershell(inspectScript);
  return JSON.parse(stdout);
}

async function waitForWindow(app, url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspect();
    const profileProcesses = state.processes.filter(process => process.path
      && process.path.toLowerCase() === edgePath.toLowerCase());
    const appProcesses = profileProcesses.filter(process => process.commandLine?.includes('--app=')
      && process.commandLine.includes(url));
    const edgePids = new Set(profileProcesses.map(process => process.pid));
    const window = state.windows.find(item => edgePids.has(item.pid) && item.title === app.title);
    if (appProcesses.length && window) return { process: appProcesses[0], window };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const state = await inspect();
  throw new Error(`No signed Edge app process/window for ${app.key}: ${JSON.stringify({
    appProcesses: state.processes.filter(p => p.commandLine?.includes('--app=')),
    windows: state.windows.filter(w => /Reel (Recorder|Notetaker)/.test(w.title)),
  })}`);
}

function launchReel(app, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [app.flag], { env, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Packaged Reel entrypoint did not exit: ${app.flag}`));
    }, 30000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Packaged Reel exited ${code ?? signal} for ${app.flag}.`));
      else resolve();
    });
  });
}

function setEdgeProfilePolicy(profileDir) {
  const script = String.raw`
$ErrorActionPreference='Stop'
$path='Software\Policies\Microsoft\Edge'
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path,$true)
$hadKey=$null -ne $key
if (-not $key) { $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path) }
try {
  if ($null -ne $key.GetValue('UserDataDir',$null)) { throw 'Edge UserDataDir policy already exists.' }
  $key.SetValue('UserDataDir',$env:REEL_SMOKE_PROFILE,[Microsoft.Win32.RegistryValueKind]::String)
} finally { $key.Close() }
[pscustomobject]@{keyExisted=$hadKey}|ConvertTo-Json -Compress
`;
  const state = JSON.parse(powershell(script, { ...process.env, REEL_SMOKE_PROFILE: profileDir }));
  createdPolicyKey = !state.keyExisted;
  registrySet = true;
}

function clearEdgeProfilePolicy() {
  if (!registrySet) return;
  powershell(String.raw`
$ErrorActionPreference='Stop'
$path='Software\Policies\Microsoft\Edge'
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path,$true)
if ($key) {
  try {
    $key.DeleteValue('UserDataDir',$false)
    $empty=$key.GetValueNames().Length -eq 0 -and $key.GetSubKeyNames().Length -eq 0
  } finally { $key.Close() }
  if ($env:REEL_SMOKE_REMOVE_POLICY_KEY -eq '1' -and $empty) {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($path,$false)
  }
}
`, { ...process.env, REEL_SMOKE_REMOVE_POLICY_KEY: createdPolicyKey ? '1' : '0' });
  registrySet = false;
}

async function cleanupProcesses() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await inspect();
    const pids = state.processes.filter(process => process.path
      && process.path.toLowerCase() === edgePath.toLowerCase()
      && !baselineEdgePids.has(process.pid)).map(process => process.pid);
    if (!pids.length) return;
    powershell(String.raw`
$ids = @($env:REEL_SMOKE_EDGE_PIDS.Split(',') | ForEach-Object { [int]$_ })
foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
`, { ...process.env, REEL_SMOKE_EDGE_PIDS: pids.join(',') });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const remaining = (await inspect()).processes.filter(process => process.path
    && process.path.toLowerCase() === edgePath.toLowerCase()
    && !baselineEdgePids.has(process.pid));
  if (remaining.length) throw new Error(`Test-owned Edge processes did not exit: ${remaining.map(p => p.pid).join(',')}`);
}

try {
  await listen();
  testRoot = await mkdtemp(join(tmpdir(), 'reel-product-entry-smoke-'));
  const raw = await readFile(organizationPath, 'utf8');
  originalOrganization = raw;
  const organization = JSON.parse(raw);
  organization.webBase = origin;
  organization.viewerBase = origin;
  await writeFile(organizationPath, JSON.stringify(organization, null, 2) + '\n');

  const initial = await inspect();
  const preexistingEdge = initial.processes.filter(p => p.path?.toLowerCase() === edgePath.toLowerCase());
  baselineEdgePids = new Set(preexistingEdge.map(p => p.pid));
  assert.equal(preexistingEdge.length, 0,
    'No Edge process may be reused from outside the isolated test profile.');

  const edgeProfile = join(testRoot, 'edge-profile');
  const localAppData = join(testRoot, 'local');
  const appData = join(testRoot, 'roaming');
  await Promise.all([mkdir(edgeProfile, { recursive: true }), mkdir(localAppData, { recursive: true }), mkdir(appData, { recursive: true })]);
  setEdgeProfilePolicy(edgeProfile);
  const env = { ...process.env, LOCALAPPDATA: localAppData, APPDATA: appData };

  const receipts = [];
  for (const app of apps) {
    const before = await inspect();
    const beforePids = new Set(before.processes.map(p => p.pid));
    const reportPromise = waitForReport(app.key);
    await launchReel(app, env);
    const [report, visible] = await Promise.all([reportPromise, waitForWindow(app, origin + app.path)]);
    assert.equal(report.standalone, true, `${app.key} page reports standalone display mode.`);
    assert.equal(report.browser, false, `${app.key} page is not in browser display mode.`);
    assert.equal(report.url, origin + app.path);
    assert.ok(!beforePids.has(visible.process.pid), `${app.key} app starts a fresh signed Edge process.`);
    assert.ok(existsSync(edgeProfile), `${app.key} uses the test-only Edge profile directory.`);
    receipts.push({
      flag: app.flag, url: report.url, title: report.title,
      display: { standalone: report.standalone, browser: report.browser },
      edgePath: visible.process.path, edgePid: visible.process.pid,
      window: { pid: visible.window.pid, title: visible.window.title, className: visible.window.className },
    });
    await cleanupProcesses();
  }
  console.log(JSON.stringify({ result: 'PASS', edgeSignature: signature.status, edgeSigner: signature.signer, receipts }));
} finally {
  const cleanupErrors = [];
  try { await cleanupProcesses(); } catch (error) { cleanupErrors.push(error); }
  try { clearEdgeProfilePolicy(); } catch (error) { cleanupErrors.push(error); }
  if (originalOrganization !== undefined) {
    try { await writeFile(organizationPath, originalOrganization); } catch (error) { cleanupErrors.push(error); }
  }
  if (server?.listening) {
    try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (testRoot) {
    try { await rm(testRoot, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Product entry smoke cleanup failed.');
}
