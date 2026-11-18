import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { parseMeetingURL } from './google-calendar.mjs';

const operationStates = {
  join: new Set(['joined','cancelled','chrome_unavailable','ambiguous_window','dedicated_window_unavailable',
    'manual_required','denied','sign_in_required','awaiting_admission','timed_out','busy','invalid_join','invalid_request','duplicate_request']),
  inspect: new Set(['in_call','left','unknown','invalid_request']),
  close: new Set(['closed','already_closed','released','close_failed','close_pending','not_owned','invalid_request']),
  cancel: new Set(['cancellation_requested','not_pending','invalid_request']),
  openGoogleSignIn: new Set(['browser_opened','chrome_unavailable','browser_failed','busy','cancelled','invalid_request']),
};
const successfulStates = new Set(['joined','in_call','left','closed','already_closed','cancellation_requested','browser_opened']);
const sessionShape = /^[0-9a-f]{32}$/;
const failure = message => new Error(message);

function isGoogleSignInURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f-\u009f\s"'\\]/u.test(value)) return false;
  const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?[^#]*)?$/iu.exec(value);
  if (!raw || !/^accounts\.google\.com(?::443)?$/iu.test(raw[1]) || raw[2] !== '/o/oauth2/v2/auth') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.port
      && !url.username && !url.password && !url.hash && url.pathname === raw[2];
  } catch { return false; }
}

/** Main-only transport. Renderer never sees this object or submits a URL/HWND. */
export function createNativeBridge({executable, spawn = spawnProcess, timeoutMs = 125_000} = {}) {
  if (!isAbsolute(executable ?? '') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 125_000)
    throw failure('Invalid native helper configuration.');
  const child = spawn(executable, [], {windowsHide:true, shell:false, stdio:['pipe','pipe','pipe']});
  const pending = new Map(), sessions = new Set(), browserOperations = new Set();
  let buffer = '', dead = false;
  function stop(reason) {
    if (dead) return;
    dead = true; child.kill();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
    pending.clear(); sessions.clear();
  }
  child.on('error', () => stop(failure('Native helper unavailable.')));
  child.on('exit', () => stop(failure('Native helper unavailable.')));
  child.stdin.on('error', () => stop(failure('Native helper unavailable.')));
  // Private UI/provider diagnostics are deliberately discarded.
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 65_536) return stop(failure('Native helper returned an invalid response.'));
    let newline;
    while ((newline=buffer.indexOf('\n')) >= 0) {
      const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1);
      let data;
      try { data=JSON.parse(line); } catch { return stop(failure('Native helper returned an invalid response.')); }
      const request=pending.get(data?.id);
      const keys = data?.state === 'joined' ? ['v','id','ok','state','sessionId','hwnd','pid'] : ['v','id','ok','state'];
      if (!request || data.v !== 1 || typeof data.ok !== 'boolean' || !operationStates[request.op]?.has(data.state)
        || data.ok !== successfulStates.has(data.state) || Object.keys(data).some(key => !keys.includes(key)))
        return stop(failure('Native helper returned an invalid response.'));
      if (data.state === 'joined' && (!data.ok || !sessionShape.test(data.sessionId ?? '')
        || !/^[1-9][0-9]{0,19}$/.test(data.hwnd ?? '') || !Number.isInteger(data.pid) || data.pid <= 0))
        return stop(failure('Native helper returned an invalid response.'));
      clearTimeout(request.timer); pending.delete(data.id);
      if (data.state === 'joined') sessions.add(data.sessionId);
      request.resolve(data);
    }
  });
  function request(op, fields) {
    if (dead) return Promise.reject(failure('Native helper unavailable.'));
    if (pending.size >= 10) return Promise.reject(failure('Native helper is busy.'));
    const id=randomUUID();
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => stop(failure('Native helper timed out.')),timeoutMs);
      pending.set(id,{resolve,reject,timer,op});
      const bytes=JSON.stringify({v:1,id,op,...fields})+'\n';
      try { child.stdin.write(bytes); } catch { stop(failure('Native helper unavailable.')); }
    });
  }
  async function close(sessionId) {
    if (!sessions.has(sessionId)) throw failure('Meeting window is not owned by Reel.');
    const result=await request('close',{sessionId});
    if (['closed','already_closed','released'].includes(result.state)) sessions.delete(sessionId);
    return result;
  }
  async function join({url,consentConfirmed,signal} = {}) {
    if (consentConfirmed !== true || !parseMeetingURL(url) || url.length > 4096 || /["\\]/u.test(url))
      throw failure('Invalid meeting or missing participant confirmation.');
    if (signal?.aborted) throw failure('Meeting join was cancelled.');
    // Obtain the ID from the outbound request synchronously, before abort can run.
    const before=new Set(pending.keys());
    const result=request('join',{url,consentConfirmed:true});
    const joinId=[...pending.keys()].find(id => !before.has(id));
    const cancel=() => { if (joinId && pending.has(joinId)) request('cancel',{joinId}).catch(() => {}); };
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      const value=await result;
      if (signal?.aborted) {
        if (value.state === 'joined') {
          const closed = await close(value.sessionId);
          if (!['closed','already_closed','released'].includes(closed.state)) {
            const unresolved = failure('Close the Reel meeting window to finish cancelling.');
            unresolved.code = 'owned_window_close_required';
            unresolved.sessionId = value.sessionId; // Main-process coordinator only.
            throw unresolved;
          }
        }
        throw failure('Meeting join was cancelled.');
      }
      return value;
    } finally { signal?.removeEventListener('abort',cancel); }
  }
  async function inspect(sessionId) {
    if (!sessions.has(sessionId)) throw failure('Meeting window is not owned by Reel.');
    return request('inspect',{sessionId});
  }
  async function openGoogleSignIn(url, {signal} = {}) {
    if (!isGoogleSignInURL(url)) throw failure('Invalid Google sign-in destination.');
    if (signal?.aborted) throw failure('Google sign-in was cancelled.');
    const before=new Set(pending.keys());
    const result=request('openGoogleSignIn',{url});
    const requestId=[...pending.keys()].find(id => !before.has(id));
    let cancellation=null;
    const cancel=() => {
      if (requestId && pending.has(requestId) && !cancellation)
        cancellation=request('cancel',{joinId:requestId}).catch(() => {});
    };
    const operation={cancel,done:null};
    signal?.addEventListener('abort',cancel,{once:true});
    operation.done=(async()=>{
      try {
        const value=await result;
        if (signal?.aborted) throw failure('Google sign-in was cancelled.');
        return value;
      } finally {
        signal?.removeEventListener('abort',cancel);
        await cancellation;
        browserOperations.delete(operation);
      }
    })();
    browserOperations.add(operation);
    return operation.done;
  }
  async function dispose() {
    // Auth windows are never owned or closed. Finish only their cancellable
    // launch workers so an in-flight sign-in cannot prevent app shutdown.
    const browsers=[...browserOperations];
    if (browsers.length) {
      for (const operation of browsers) operation.cancel();
      await Promise.allSettled(browsers.map(operation => operation.done));
    }
    // The caller must first await coordinator.cancel()/dispose() so no recorder
    // startup or native join can race shutdown. Never discard live ownership.
    if (pending.size) throw failure('Finish cancelling meeting operations before shutting down.');
    for (const sessionId of [...sessions]) {
      const result = await close(sessionId);
      if (!['closed','already_closed','released'].includes(result.state))
        throw failure('Close the Reel meeting window before shutting down.');
    }
    stop(failure('Native helper stopped.'));
  }
  return {join,inspect,close,openGoogleSignIn,dispose};
}
