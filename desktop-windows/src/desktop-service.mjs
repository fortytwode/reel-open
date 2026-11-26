import { routeGoogleMeetings } from './google-calendar.mjs';

const defaults = ownerUserID => ({ownerUserID, autoJoin:false, participantConsent:false,
  systemAudioConsent:false, selection:{useAll:true,ids:[]}});
const messages = {
  idle:'Keep Reel open and this computer awake to check upcoming meetings.',
  scheduled:'Ready for upcoming meetings in your selected calendars.',
  joining:'Opening a dedicated Chrome window with microphone and camera off.',
  capturing:'Recording the meeting window and all computer sound. Saved on this computer.',
  saving:'Finishing your local recording.', completed:'Your recording was saved on this computer.',
  close_required:'Close the meeting window Reel opened, then refresh to continue.',
  calendar_unavailable:'Calendar could not be refreshed. Check your connection or reconnect Google Calendar.',
  failed:'The meeting could not start automatically. Check Chrome and join the meeting manually.',
  save_failed:'The recording could not be completed. Open the recordings folder to recover available local files.',
  retry_wait:'Reel will retry the meeting connection shortly.', cancelled:'Meeting setup was cancelled.'
};
const keys = ['ownerUserID','expectedOwnerUserID','autoJoin','participantConsent','systemAudioConsent','selection'];
const selectionKey = value => JSON.stringify({useAll:value.useAll,ids:[...new Set(value.ids)].sort()});

export function desktopLaunchAction(args = []) {
  let action = null;
  for (const arg of args) {
    const next = arg === '--open-recorder' ? 'openRecorder'
      : arg === '--open-notetaker' ? 'openNotetaker' : null;
    if (!next) continue;
    if (action && action !== next) return null;
    action = next;
  }
  return action;
}

export function desktopProductURL(action, org) {
  const path = action === 'openRecorder' ? '/record'
    : action === 'openNotetaker' ? '/notetaker' : null;
  if (!path) throw Error('Unknown Reel product launch.');
  if (!org?.webBase) throw Error('The organization has not configured its web URLs.');
  return org.webBase + path;
}

export function desktopBrowserAppArguments(action, org) {
  return [`--app=${desktopProductURL(action, org)}`];
}

/** Main-process composition. Only state()/action() are exposed by the restricted UI preload.
 * All tokens, join URLs, native ownership and output paths remain in this process.
 */
export function createDesktopService({auth,org,store,discover,createCoordinator,openExternal,openProduct,openRecordings,processor,shareMeeting,onState=()=>{},fetch:fetcher=globalThis.fetch} = {}) {
  const configured = Boolean(auth && createCoordinator);
  let owner = auth?.getProfile()?.userID ?? null, ownerEmail=auth?.getProfile()?.email ?? null, generation=0, cache=null, calendarController=null;
  let pulsePromise=null, closed=false, closing=false, error=null, settingsCache=null, settingsRevision=0;
  const activeShares=new Set();
  let settingsTail=Promise.resolve(),disposePromise=null;
  let calendars=[],meetings=[],calendarOwner=null,routingUnavailable=false;
  const routingMessage='Cloud routing could not be checked. Automatic Meet and Teams joins are paused; Zoom can continue.';
  const settings = () => {
    const id=auth?.getProfile()?.userID ?? null;
    if (!id) return defaults(null);
    if (settingsCache?.ownerUserID !== id) settingsCache=store.getSettings(id);
    return settingsCache;
  };
  function state() {
    const profile=auth?.getProfile() ?? null, status=coordinator?.getState() ?? {phase:'idle'};
    // Do not surface a previous owner's meeting state while cancellation is saving.
    const phase=status.ownerUserID && status.ownerUserID !== profile?.userID ? 'idle' : status.phase;
    const currentCalendar=calendarOwner===profile?.userID;
    return {configured,profile,settings:structuredClone(settings()),calendars:structuredClone(currentCalendar?calendars:[]),
      meetings:structuredClone(currentCalendar?meetings:[]),recordings:profile ? store.list(profile.userID).map(recording=>({
        ...recording,sharing:activeShares.has(`${profile.userID}:${recording.id}`)})) : [],
      status:{phase,message:routingUnavailable && ['idle','scheduled'].includes(phase) ? routingMessage : messages[phase] ?? messages.idle},error};
  }
  function emit() { if (!closed) onState(state()); }
  function invalidate() {
    generation++; settingsRevision++; cache=null; calendarController?.abort(); calendarController=null;
    calendars=[];meetings=[];calendarOwner=null;routingUnavailable=false;error=null;settingsCache=null;
  }
  async function calendarDiscover(args) {
    if (args.signal?.aborted) throw Error('Calendar refresh cancelled.');
    const profile=auth.getProfile(), key=selectionKey(args.selection), version=generation;
    let result;
    if (cache?.ownerUserID === profile?.userID && cache.ownerEmail === profile?.email
      && cache.key === key && Date.now()-cache.at < 10_000) result=cache.result;
    else {
      result=await discover(args);
      if (args.signal?.aborted || version !== generation || result.ownerUserID !== auth.getProfile()?.userID
        || profile?.email !== auth.getProfile()?.email) throw Error('The calendar account changed.');
      cache={ownerUserID:result.ownerUserID,ownerEmail:profile.email,key,at:Date.now(),result};
    }
    // Google discovery can be cached briefly; cloud ownership must be fresh before each coordinator refresh/join.
    const routed=await routeGoogleMeetings({auth,snapshot:result,routingURL:org && org.meetingServiceURL + '/calendar/desktop',fetch:fetcher,signal:args.signal});
    if (args.signal?.aborted || version !== generation || profile?.userID !== auth.getProfile()?.userID
      || profile?.email !== auth.getProfile()?.email) throw Error('The calendar account changed.');
    routingUnavailable=routed.routingUnavailable;
    error=routingUnavailable ? routingMessage : null;
    return routed;
  }
  const coordinator=configured ? createCoordinator({auth, calendar:{discover:calendarDiscover},getSettings:settings,
    hasCompleted:args=>store.hasCompleted(args),markCompleted:args=>store.markCompleted(args)}) : null;
  const unsubscribeStatus=coordinator?.onStateChange(emit);
  const unsubscribeProcessing=processor?.onStateChange(emit);
  const unsubscribeAuth=auth?.onStateChange(() => {
    const next=auth.getProfile()?.userID ?? null;
    if (owner !== next || ownerEmail !== auth.getProfile()?.email || !auth.getProfile()?.calendarConnected) {
      owner=next;ownerEmail=auth.getProfile()?.email ?? null;invalidate();
    }
    // The coordinator independently invalidates on the same auth notification.
    emit();
    void processor?.resume().catch(()=>{});
  });
  async function pulse() {
    if (!configured || closed || closing) return;
    if (pulsePromise) {
      // The network must not hold up an existing recording's local deadline or
      // owned-window checks. New joins still wait for the calendar refresh.
      if (['capturing','saving','close_required'].includes(coordinator.getState().phase)) await coordinator.tick();
      return pulsePromise;
    }
    const operation=(async()=>{
      const profile=auth.getProfile(), version=generation;
      if (!profile?.calendarConnected) { await coordinator.refresh(); emit(); return; }
      const controller=new AbortController(); calendarController=controller;
      try {
        const result=await calendarDiscover({auth,selection:settings().selection,now:new Date(),signal:controller.signal});
        if (closed || closing || version!==generation || profile.userID!==auth.getProfile()?.userID) return;
        calendarOwner=profile.userID;
        calendars=result.calendars.map(({id,title,primary})=>({id,title,primary:primary===true}));
        meetings=result.meetings.map(({id,title,start,end,platform})=>({id,title,start,end,platform}));
        error=result.routingUnavailable ? routingMessage : null;emit(); await coordinator.refresh(); await coordinator.tick();
      } catch {
        if (closed || closing || version!==generation) return;
        cache=null;calendars=[];meetings=[];
        error='Could not refresh your calendar. Reconnect Google Calendar or try again.';
        await coordinator.cancel();emit();
      } finally { if(calendarController===controller) calendarController=null; }
    })();
    pulsePromise=operation;
    try { await operation; } finally { if(pulsePromise===operation) pulsePromise=null; }
  }
  function requireOwner(expected) {
    const id=auth?.getProfile()?.userID;
    if (!id) throw Error('Please sign in to continue.');
    if (expected !== undefined && expected!==id) throw Error('The account changed. Refresh your settings.');
    return id;
  }
  async function action(name,payload) {
    if (closed || closing) throw Error('Reel is shutting down.');
    if (name==='openLibrary') {
      if (!org) throw Error('The organization has not configured its web URLs.');
      await openExternal(org.notesBaseURL);
    }
    else if (name==='openRecorder' || name==='openNotetaker') await openProduct(name);
    else if (name==='openRecordings') await openRecordings(requireOwner());
    else {
      if (!configured) throw Error('Automatic meetings are unavailable in this build.');
      if (name==='signIn' || name==='connectCalendar') {
        await auth.signIn({connectCalendar:name==='connectCalendar'});
        invalidate();owner=auth.getProfile()?.userID ?? null; await pulse();
      } else if(name==='cancelSignIn') auth.cancelSignIn();
      else if(name==='signOut') { auth.signOut();await coordinator.cancel(); }
      else if(name==='disconnectCalendar') {
        const id=requireOwner(); auth.disconnectCalendar();await coordinator.cancel();
        const write=settingsTail.catch(()=>{}).then(()=>{
          const value=store.getSettings(id);
          return store.saveSettings({...value,ownerUserID:id,expectedOwnerUserID:id,autoJoin:false});
        });
        settingsTail=write;write.catch(()=>{});await write;
      } else if(name==='saveSettings') {
        if (!payload || typeof payload!=='object' || Array.isArray(payload) || Object.keys(payload).some(key=>!keys.includes(key)))
          throw Error('Invalid recording settings.');
        const id=requireOwner(payload.expectedOwnerUserID), version=generation;
        if (payload.expectedOwnerUserID!==id || (payload.ownerUserID!==undefined && payload.ownerUserID!==id))
          throw Error('The account changed. Refresh your settings.');
        if (![payload.autoJoin,payload.participantConsent,payload.systemAudioConsent].every(flag=>typeof flag==='boolean')
          || typeof payload.selection?.useAll!=='boolean' || !Array.isArray(payload.selection.ids)
          || payload.selection.ids.length>250 || payload.selection.ids.some(value=>typeof value!=='string'||!value||value.length>1024))
          throw Error('Invalid recording settings.');
        const next={ownerUserID:id,autoJoin:payload.autoJoin && payload.participantConsent && payload.systemAudioConsent,
          participantConsent:payload.participantConsent,systemAudioConsent:payload.systemAudioConsent,
          selection:{useAll:payload.selection.useAll,ids:[...new Set(payload.selection.ids)]}};
        if(next.autoJoin && !auth.getProfile().calendarConnected) throw Error('Connect Google Calendar first.');
        const revision=++settingsRevision, changed=JSON.stringify(settings())!==JSON.stringify(next);
        let cancellation=Promise.resolve();
        if(changed) {
          // Revoke immediately, before disk I/O; only durable settings can enable a new capture.
          settingsCache={...next,autoJoin:false};cache=null;calendarController?.abort();
          cancellation=coordinator.cancel();
        }
        // Enqueue at action arrival, before awaiting cancellation, so a slower
        // older enable can never persist after a newer disable.
        const write=settingsTail.catch(()=>{}).then(async()=>{
          await cancellation;
          // A stale enable is discarded. An already requested revocation is
          // still persisted to its original owner's private settings.
          if((version!==generation || auth.getProfile()?.userID!==id) && next.autoJoin) return null;
          return store.saveSettings({...next,expectedOwnerUserID:id});
        });
        settingsTail=write;
        // A caller may disappear during shutdown; keep rejections observed.
        write.catch(()=>{});
        const saved=await write;
        if (version!==generation || requireOwner()!==id) throw Error('The account changed. Refresh your settings.');
        if (revision!==settingsRevision) return state();
        settingsCache=saved;error=null;emit();await pulse();
      } else if(name==='retryProcessing') {
        const id=requireOwner(payload?.expectedOwnerUserID);
        if (typeof payload?.id !== 'string' || !store.getProcessing({ownerUserID:id,id:payload.id})) throw Error('Recording is unavailable.');
        void processor?.process({ownerUserID:id,id:payload.id}).catch(()=>{});
      } else if(name==='shareRecording') {
        const id=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (typeof payload?.id !== 'string' || !shareMeeting) throw Error('Meeting sharing is unavailable.');
        const key=`${id}:${payload.id}`;activeShares.add(key);emit();
        try { await shareMeeting.share({ownerUserID:id,id:payload.id,...(payload.includeTranscript === true ? { includeTranscript:true } : {})}); }
        finally { activeShares.delete(key);emit(); }
      } else if(name==='stopRecording') { await coordinator.cancel();emit(); }
      else if(name==='refresh') { cache=null;await pulse(); }
      else throw Error('Unknown Reel action.');
    }
    return state();
  }
  function dispose() {
    if(closed) return Promise.resolve();
    if(disposePromise) return disposePromise;
    closing=true;calendarController?.abort();auth?.cancelSignIn();processor?.cancel();
    disposePromise=(async()=>{
      // Consent mutations are durable before the process may exit.
      const cancellation=coordinator?.cancel();
      try { await settingsTail; }
      catch {
        await cancellation;
        const failure=Error('Your latest recording settings have not been saved. Free disk space or restore access to your local files, then retry saving before quitting.');
        failure.code='settings_not_saved';throw failure;
      }
      await cancellation;await coordinator?.dispose();
      processor?.dispose();closed=true;unsubscribeStatus?.();unsubscribeProcessing?.();unsubscribeAuth?.();
    })().catch(cause=>{closing=false;disposePromise=null;throw cause;});
    return disposePromise;
  }
  return {state,action,pulse,dispose};
}
