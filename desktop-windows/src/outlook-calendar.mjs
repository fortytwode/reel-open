import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {normalizeGoogleEvent} from './google-calendar.mjs';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../native/ReelNativeJoin.exe', import.meta.url));
const id = 'outlook:default';
const reconnect = () => Error('Open classic Outlook with the same work account, then refresh.');
async function readOutlook({email, readEvents, signal}) {
  if (process.platform !== 'win32') throw reconnect();
  const {stdout} = await run(helper, ['--outlook-calendar'], {
    windowsHide:true, timeout:12000, maxBuffer:4*1024*1024, signal,
    env:{...process.env,REEL_OUTLOOK_EMAIL:email,REEL_OUTLOOK_READ_EVENTS:readEvents?'1':'0'}
  });
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}

// A local Outlook event is never used as a Google event ID for recap delivery.
export async function discoverOutlookMeetings({auth, selection, now=new Date(), signal}, read=readOutlook) {
  const owner=auth.getProfile();
  if (!owner?.userID || !owner.email || signal?.aborted) throw reconnect();
  const readEvents=selection.useAll || selection.ids.includes(id);
  let result;
  try { result=await read({email:owner.email,readEvents,signal}); } catch { throw reconnect(); }
  const current=auth.getProfile();
  if (signal?.aborted || current?.userID!==owner.userID || current?.email!==owner.email ||
      result?.account?.toLowerCase()!==owner.email.toLowerCase() || !Array.isArray(result.events) || result.events.length>1000)
    throw reconnect();
  const meetings=[];
  const horizonEnd=new Date(+now+7*86400000);
  if (readEvents) for (const event of result.events) {
    if (!event || typeof event.id!=='string' || !event.id || event.id.length>800) continue;
    const meeting=normalizeGoogleEvent(id,{id:event.id+'@'+event.start,summary:event.subject,
      hangoutLink:event.url,start:{dateTime:event.start},end:{dateTime:event.end}}, {ownerEmail:owner.email, now, horizonEnd});
    if (meeting) meetings.push({...meeting,calendar:null});
  }
  meetings.sort((a,b)=>a.start.localeCompare(b.start));
  return {ownerUserID:owner.userID,calendars:[{id,title:'Outlook work calendar',primary:true}],meetings,fetchedAt:now.toISOString()};
}
