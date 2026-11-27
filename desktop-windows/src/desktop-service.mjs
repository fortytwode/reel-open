import { routeGoogleMeetings } from './google-calendar.mjs';
import { normalizeTrimRange } from './trim-range.mjs';

const defaults = ownerUserID => ({ownerUserID, autoJoin:false, participantConsent:false,
  systemAudioConsent:false, meetingReminders:false, localTranscription:false, selection:{useAll:true,ids:[]}});
const messages = {
  idle:'Keep Reel open and this computer awake to check upcoming meetings.',
  scheduled:'Ready for upcoming meetings in your selected calendars.',
  joining:'Opening a dedicated Chrome window with microphone and camera off.',
  capturing:'Recording the meeting window and all computer sound. Saved on this computer.',
  saving:'Finishing your local recording.', completed:'Your recording was saved on this computer.',
  close_required:'Close the meeting window Reel opened, then refresh to continue.',
  calendar_unavailable:'Calendar could not be refreshed. Check your connection or reconnect Google Calendar.',
  failed:'The meeting could not start. Check the meeting and your Chrome profile, then try again.',
  microphone_unavailable:'Reel could not use the microphone. Check Windows microphone permissions or start the meeting with Include my microphone off.',
  save_failed:'The recording could not be completed. Open the recordings folder to recover available local files.',
  retry_wait:'Reel will retry the meeting connection shortly.', cancelled:'Meeting setup was cancelled.'
};
const keys = ['ownerUserID','expectedOwnerUserID','autoJoin','participantConsent','systemAudioConsent','meetingReminders','localTranscription','selection'];
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

export function createCompanionStartup({ app, shell, windowsStore, executable, organizationKey }) {
  // MSIX owns its startup task by app identity across upgrades. Its executable
  // is in a versioned WindowsApps directory, so do not register it via Run.
  if (windowsStore) return {
    state: () => ({ mode: 'windows-settings' }),
    openSettings: () => shell.openExternal('ms-settings:startupapps'),
  };
  if (!app.isPackaged) return null;
  const options = { path: executable, args: [], name: `Reel Companion ${organizationKey}` };
  const enabled = () => app.getLoginItemSettings({ path: options.path, args: options.args }).launchItems
    .some(item => item.name === options.name && item.scope === 'user' && item.enabled);
  return {
    state: () => ({ mode: 'portable', enabled: enabled() }),
    setEnabled(openAtLogin) {
      app.setLoginItemSettings({ ...options, openAtLogin, enabled: openAtLogin });
      if (enabled() !== openAtLogin) throw Error('Windows did not save the startup setting.');
    },
  };
}

/** Main-process composition. Only state()/action() are exposed by the restricted UI preload.
 * All tokens, join URLs, native ownership and output paths remain in this process.
 */
export function createDesktopService({auth,org,store,discover,createCoordinator,openExternal,openProduct,openRecordings,openRecording,revealRecording,copyText,exportTrimmedCopy,startup,processor,shareMeeting,reminderScheduler,manualCapture,onState=()=>{},fetch:fetcher=globalThis.fetch} = {}) {
  const configured = Boolean(auth && createCoordinator);
  let owner = auth?.getProfile()?.userID ?? null, ownerEmail=auth?.getProfile()?.email ?? null, generation=0, cache=null, calendarController=null;
  let pulsePromise=null, closed=false, closing=false, error=null, settingsCache=null, settingsRevision=0;
  const activeShares=new Set();
  const activeRecordingOperations=new Map();
  const activeExports=new Map();
  let settingsTail=Promise.resolve(),disposePromise=null;
  let calendars=[],meetings=[],calendarOwner=null,routingUnavailable=false;
  const routingMessage='Cloud routing could not be checked. Local Meet and Teams joins are paused. Zoom can continue.';
  const settings = () => {
    const id=auth?.getProfile()?.userID ?? null;
    if (!id) return defaults(null);
    if (settingsCache?.ownerUserID !== id) settingsCache=store.getSettings(id);
    return settingsCache;
  };
  function state() {
    const profile=auth?.getProfile() ?? null, status=coordinator?.getState() ?? {phase:'idle'};
    // Do not surface a previous owner's meeting state while cancellation is saving.
    const currentStatus = !status.ownerUserID || status.ownerUserID === profile?.userID;
    const phase = currentStatus ? status.phase : 'idle';
    const messageKey = currentStatus && status.reason === 'microphone_unavailable' ? status.reason : phase;
    const currentCalendar=calendarOwner===profile?.userID;
    return {configured,profile,settings:structuredClone(settings()),startup:startup?.state() ?? null,calendars:structuredClone(currentCalendar?calendars:[]),
      meetingReminderError:reminderScheduler?.error ?? null,
      meetings:structuredClone(currentCalendar?meetings:[]),recordings:profile ? store.list(profile.userID).map(recording=>({
        ...recording,sharing:activeShares.has(`${profile.userID}:${recording.id}`),localOperation:activeRecordingOperations.get(`${profile.userID}:${recording.id}`)?.label ?? null})) : [],
      status:{phase,message:routingUnavailable && ['idle','scheduled'].includes(phase) ? routingMessage : messages[messageKey] ?? messages.idle},
      manualCapture:(()=>{const value=manualCapture?.state();return value?.ownerUserID && value.ownerUserID!==profile?.userID
        ? {phase:'idle'} : value ?? {phase:'idle'};})(),error};
  }
  function emit() { if (!closed) onState(state()); }
  function invalidate() {
    generation++; settingsRevision++; cache=null; calendarController?.abort(); calendarController=null;
    reminderScheduler?.update({owner:null,reminders:false,meetings:[]});
    calendars=[];meetings=[];calendarOwner=null;routingUnavailable=false;error=null;settingsCache=null;
  }
  async function calendarDiscover(args) {
    if (args.signal?.aborted) throw Error('Calendar refresh cancelled.');
    const profile=auth.getProfile(), key=selectionKey(args.selection), version=generation;
    let result;
    if (cache?.ownerUserID === profile?.userID && cache.ownerEmail === profile?.email
      && cache.key === key && Date.now()-cache.at < 10_000) result=cache.result;
    else {
      try {
        result = profile?.calendarConnected ? await discover(args) : null;
      } catch (error) {
        if (!args.pastedLink) throw error;
      }
      const hasCalendarResult = Boolean(result);
      if (!result && args.pastedLink) result = { ownerUserID: profile?.userID, calendars: [], meetings: [] };
      if (!result) throw Error('Connect Google Calendar to continue.');
      if (args.signal?.aborted || version !== generation || result.ownerUserID !== auth.getProfile()?.userID
        || profile?.email !== auth.getProfile()?.email) throw Error('The calendar account changed.');
      if (hasCalendarResult) cache={ownerUserID:result.ownerUserID,ownerEmail:profile.email,key,at:Date.now(),result};
    }
    // Google discovery can be cached briefly; cloud ownership must be fresh before each coordinator refresh/join.
    const routed=await routeGoogleMeetings({auth,snapshot:result,routingURL:org && org.meetingServiceURL + '/calendar/desktop',fetch:fetcher,signal:args.signal,now:args.now,pastedLink:args.pastedLink});
    if (args.signal?.aborted || version !== generation || profile?.userID !== auth.getProfile()?.userID
      || profile?.email !== auth.getProfile()?.email) throw Error('The calendar account changed.');
    routingUnavailable=routed.routingUnavailable;
    error=routingUnavailable ? routingMessage : null;
    return routed;
  }
  const coordinator=configured ? createCoordinator({auth, calendar:{discover:calendarDiscover},
    getSettings:()=>manualCapture?.isActive?.() ? {...settings(),autoJoin:false} : settings(),
    hasCompleted:args=>store.hasCompleted(args),markCompleted:args=>store.markCompleted(args)}) : null;
  const unsubscribeStatus=coordinator?.onStateChange(emit);
  const unsubscribeProcessing=processor?.onStateChange(emit);
  const unsubscribeAuth=auth?.onStateChange(() => {
    const next=auth.getProfile()?.userID ?? null;
    if (owner !== next || ownerEmail !== auth.getProfile()?.email || !auth.getProfile()?.calendarConnected) {
      if (owner !== next && manualCapture?.isActive()) void manualCapture.stop(owner).catch(()=>{});
      if (owner !== next) manualCapture?.clearCatalog();
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
      if (!profile?.calendarConnected) { reminderScheduler?.update({owner:profile?.userID,reminders:false,meetings:[]}); await coordinator.refresh(); await coordinator.tick(); emit(); return; }
      const controller=new AbortController(); calendarController=controller;
      try {
        const result=await calendarDiscover({auth,selection:settings().selection,now:new Date(),signal:controller.signal});
        if (closed || closing || version!==generation || profile.userID!==auth.getProfile()?.userID) return;
        reminderScheduler?.update({owner:profile.userID,reminders:settings().meetingReminders,meetings:result.meetings,at:new Date()});
        calendarOwner=profile.userID;
        calendars=result.calendars.map(({id,title,primary})=>({id,title,primary:primary===true}));
        meetings=result.meetings.map(({id,title,start,end,platform})=>({id,title,start,end,platform}));
        error=result.routingUnavailable ? routingMessage : null;emit(); await coordinator.refresh(); await coordinator.tick();
      } catch {
        if (closed || closing || version!==generation) return;
        cache=null;calendars=[];meetings=[];
        reminderScheduler?.update({owner:profile?.userID,reminders:false,meetings:[]});
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
    let transcriptResponse = null;
    if (['listCaptureWindows','startWindowRecording','stopWindowRecording','pauseWindowRecording','resumeWindowRecording'].includes(name)) {
      if (!manualCapture) throw Error('Native window recording is unavailable in this build.');
      if (name==='listCaptureWindows') {
        if (Object.keys(payload ?? {}).some(key=>!['expectedOwnerUserID'].includes(key))) throw Error('Invalid window picker request.');
        await manualCapture.list(requireOwner(payload?.expectedOwnerUserID));
      } else if (name==='startWindowRecording') {
        if (!payload || typeof payload!=='object' || Array.isArray(payload)
          || Object.keys(payload).some(key=>!['expectedOwnerUserID','sourceID','consentConfirmed','includeMicrophone'].includes(key))
          || typeof payload.sourceID!=='string' || typeof payload.consentConfirmed!=='boolean')
          throw Error('Invalid window recording request.');
        const meetingPhase=coordinator?.getState()?.phase ?? 'idle';
        if (['joining','capturing','saving','close_required','retry_wait'].includes(meetingPhase))
          throw Error('Finish the current meeting recording before starting a window recording.');
        if (settings().autoJoin) throw Error('Turn off automatic joining before starting a manual window recording.');
        await manualCapture.start({ownerUserID:requireOwner(payload.expectedOwnerUserID),sourceID:payload.sourceID,
          consentConfirmed:payload.consentConfirmed,includeMicrophone:payload.includeMicrophone});
      } else {
        if (Object.keys(payload ?? {}).some(key=>!['expectedOwnerUserID'].includes(key))) throw Error('Invalid window stop request.');
        const ownerID=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (name==='stopWindowRecording') await manualCapture.stop(ownerID);
        else await manualCapture.setPaused(ownerID,name==='pauseWindowRecording');
      }
      emit();
    }
    else if (name==='openLibrary') {
      if (!org) throw Error('The organization has not configured its web URLs.');
      await openExternal(org.notesBaseURL);
    }
    else if (name==='openRecorder' || name==='openNotetaker') await openProduct(name);
    else if (name==='openRecordings') await openRecordings(requireOwner());
    else if (name==='openStartupSettings' && startup?.openSettings) await startup.openSettings();
    else if (name==='setCompanionStartup' && startup?.setEnabled) {
      if (typeof payload?.enabled !== 'boolean') throw Error('Choose whether Reel should open when you sign in to Windows.');
      startup.setEnabled(payload.enabled);
    }
    else {
      if (!configured && !['renameRecording','deleteRecording'].includes(name)) throw Error('Automatic meetings are unavailable in this build.');
      if (name==='signIn' || name==='connectCalendar') {
        await auth.signIn({connectCalendar:name==='connectCalendar'});
        invalidate();owner=auth.getProfile()?.userID ?? null; await pulse();
      } else if(name==='cancelSignIn') auth.cancelSignIn();
      else if(name==='signOut') {
        if(manualCapture?.isActive()) await manualCapture.stop(requireOwner());
        auth.signOut();await coordinator.cancel();
      }
      else if(name==='disconnectCalendar') {
        const id=requireOwner(); auth.disconnectCalendar();await coordinator.cancel();
        const write=settingsTail.catch(()=>{}).then(()=>{
          const value=store.getSettings(id);
          return store.saveSettings({...value,ownerUserID:id,expectedOwnerUserID:id,autoJoin:false,meetingReminders:false});
        });
        settingsTail=write;write.catch(()=>{});await write;
      } else if(name==='saveSettings') {
        if (!payload || typeof payload!=='object' || Array.isArray(payload) || Object.keys(payload).some(key=>!keys.includes(key)))
          throw Error('Invalid recording settings.');
        const id=requireOwner(payload.expectedOwnerUserID), version=generation;
        if (payload.expectedOwnerUserID!==id || (payload.ownerUserID!==undefined && payload.ownerUserID!==id))
          throw Error('The account changed. Refresh your settings.');
        if (![payload.autoJoin,payload.participantConsent,payload.systemAudioConsent,payload.meetingReminders,payload.localTranscription].every(flag=>typeof flag==='boolean')
          || typeof payload.selection?.useAll!=='boolean' || !Array.isArray(payload.selection.ids)
          || payload.selection.ids.length>250 || payload.selection.ids.some(value=>typeof value!=='string'||!value||value.length>1024))
          throw Error('Invalid recording settings.');
        const next={ownerUserID:id,autoJoin:payload.autoJoin && payload.participantConsent && payload.systemAudioConsent,
          participantConsent:payload.participantConsent,systemAudioConsent:payload.systemAudioConsent,meetingReminders:payload.meetingReminders,localTranscription:payload.localTranscription,
          selection:{useAll:payload.selection.useAll,ids:[...new Set(payload.selection.ids)]}};
        if (manualCapture?.isActive() && next.autoJoin) throw Error('Stop the manual window recording before enabling automatic joining.');
        if(next.autoJoin && !auth.getProfile().calendarConnected) throw Error('Connect Google Calendar first.');
        const revision=++settingsRevision, changed=JSON.stringify(settings())!==JSON.stringify(next);
        let cancellation=Promise.resolve();
        if(changed) {
          // Revoke immediately, before disk I/O; only durable settings can enable a new capture.
          settingsCache={...next,autoJoin:false};cache=null;calendarController?.abort();
          if(!next.meetingReminders) reminderScheduler?.update({owner:id,reminders:false,meetings:[]});
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
      } else if(name==='joinMeeting' || name==='joinMeetingLink') {
        const id=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (manualCapture?.isActive()) throw Error('Stop the manual window recording before starting a meeting recording.');
        const pasted = name==='joinMeetingLink';
        const allowed = ['expectedOwnerUserID', 'includeMicrophone', ...(pasted ? ['url', 'participantsConfirmed'] : ['id'])];
        if (Object.keys(payload).some(key => !allowed.includes(key))
          || (payload.includeMicrophone !== undefined && typeof payload.includeMicrophone !== 'boolean'))
          throw Error('Invalid meeting request.');
        if (pasted && (typeof payload.url !== 'string' || payload.url.length > 8_192 || payload.participantsConfirmed !== true))
          throw Error('Enter a meeting link and confirm that participants agreed to recording.');
        if (!pasted && (typeof payload.id !== 'string' || !payload.id || payload.id.length > 4_096))
          throw Error('Choose a meeting from your calendar.');
        const version=generation, revision=settingsRevision;
        await settingsTail;
        if (version!==generation || revision!==settingsRevision || requireOwner()!==id || closing)
          throw Error('Your account or recording settings changed. Refresh and try again.');
        if (manualCapture?.isActive()) throw Error('Stop the manual window recording before starting a meeting recording.');
        cache=null;
        await coordinator.joinMeeting({ ownerUserID:id, microphone:payload.includeMicrophone === true,
          ...(pasted ? { url:payload.url, participantsConfirmed:payload.participantsConfirmed } : { meetingId:payload.id }) });
      } else if(name==='cancelJoin') {
        const id=requireOwner(payload?.expectedOwnerUserID ?? null);
        await coordinator.cancelJoin(id);
      } else if(name==='retryProcessing') {
        const id=requireOwner(payload?.expectedOwnerUserID);
        if (typeof payload?.id !== 'string' || !store.getProcessing({ownerUserID:id,id:payload.id})) throw Error('Recording is unavailable.');
        void processor?.process({ownerUserID:id,id:payload.id}).catch(()=>{});
      } else if(name==='playRecording') {
        const ownerUserID=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (!/^[0-9a-f]{32}$/.test(payload?.id ?? '') || typeof openRecording !== 'function') throw Error('Recording is unavailable.');
        const file=store.getRecordingPath({ownerUserID,id:payload.id});
        requireOwner(ownerUserID);
        if (!file) throw Error('Recording is unavailable.');
        await openRecording(file);
      } else if(name==='revealRecording') {
        const ownerUserID=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (!/^[0-9a-f]{32}$/.test(payload?.id ?? '') || typeof revealRecording !== 'function') throw Error('Recording is unavailable.');
        const file=store.getRecordingPath({ownerUserID,id:payload.id});
        requireOwner(ownerUserID);
        if (!file) throw Error('Recording is unavailable.');
        revealRecording(file);
      } else if(name==='copyTranscript') {
        const ownerUserID=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (!/^[0-9a-f]{32}$/.test(payload?.id ?? '') || typeof copyText !== 'function') throw Error('Transcript is unavailable.');
        const processing=store.getProcessing({ownerUserID,id:payload.id});
        if (processing?.transcriptComplete !== true || !processing.text?.trim()) throw Error('Transcript is unavailable.');
        requireOwner(ownerUserID);
        copyText(processing.text);
      } else if(name==='getTranscript') {
        const ownerUserID=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (!payload || typeof payload!=='object' || Array.isArray(payload)
          || Object.keys(payload).some(key=>!['id','expectedOwnerUserID'].includes(key))
          || !/^[0-9a-f]{32}$/.test(payload.id ?? '')) throw Error('Transcript is unavailable.');
        const recording=store.list(ownerUserID).find(item=>item.id===payload.id);
        const processing=store.getProcessing({ownerUserID,id:payload.id});
        if (!recording || processing?.transcriptComplete !== true || !processing.text?.trim()) throw Error('Transcript is unavailable.');
        requireOwner(ownerUserID);
        transcriptResponse={title:recording.title,text:processing.text};
      } else if(name==='exportTrimmedCopy') {
        const ownerUserID=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (!/^[0-9a-f]{32}$/.test(payload?.id ?? '') || typeof exportTrimmedCopy !== 'function') throw Error('Recording export is unavailable.');
        const recording=store.list(ownerUserID).find(item=>item.id===payload.id);
        const file=store.getRecordingPath({ownerUserID,id:payload.id});
        const range=normalizeTrimRange(payload.start,payload.end,recording?.durationSeconds);
        if (!recording || !file || !range) throw Error('Choose a valid trim range within this saved recording.');
        const key=`${ownerUserID}:${recording.id}`;
        if(activeExports.has(key)) throw Error('This recording is already being exported.');
        const exporting=(async()=>{
          await exportTrimmedCopy({ownerUserID,id:recording.id,file,title:recording.title,...range});
          requireOwner(ownerUserID);
        })();
        activeExports.set(key,exporting);
        try { await exporting; }
        finally { if(activeExports.get(key)===exporting) activeExports.delete(key); }
      } else if(name==='shareRecording') {
        const id=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (typeof payload?.id !== 'string' || !shareMeeting) throw Error('Meeting sharing is unavailable.');
        const key=`${id}:${payload.id}`;activeShares.add(key);emit();
        try { await shareMeeting.share({ownerUserID:id,id:payload.id,...(payload.includeTranscript === true ? { includeTranscript:true } : {}),
          ...(typeof payload.password === 'string' ? { password:payload.password } : {}),
          ...(typeof payload.expiry === 'string' ? { expiry:payload.expiry } : {})}); }
        finally { activeShares.delete(key);emit(); }
      } else if(name==='updateMeetingShareAccess') {
        const id=requireOwner(payload?.expectedOwnerUserID ?? null);
        if (!payload || typeof payload!=='object' || Array.isArray(payload)
          || Object.keys(payload).some(key=>!['expectedOwnerUserID','id','password','removePassword','expiry'].includes(key))
          || typeof payload.id!=='string' || !/^[0-9a-f]{32}$/.test(payload.id)
          || (payload.password!==undefined && (typeof payload.password!=='string' || payload.password.length>1024))
          || (payload.removePassword!==undefined && typeof payload.removePassword!=='boolean')
          || (payload.expiry!==undefined && typeof payload.expiry!=='string') || !shareMeeting?.updateAccess)
          throw Error('Invalid meeting link settings.');
        const key=`${id}:${payload.id}`;activeShares.add(key);emit();
        try { await shareMeeting.updateAccess({ownerUserID:id,id:payload.id,
          ...(typeof payload.password==='string' && payload.password ? {password:payload.password}:{}),
          ...(payload.removePassword===true ? {removePassword:true}:{}),
          ...(typeof payload.expiry==='string' ? {expiry:payload.expiry}:{})}); }
        finally { activeShares.delete(key);emit(); }
      } else if(name==='renameRecording' || name==='deleteRecording') {
        const id=requireOwner(payload?.expectedOwnerUserID ?? null), deleting=name==='deleteRecording';
        const allowed=deleting?['expectedOwnerUserID','id','localOnlyConfirmed']:['expectedOwnerUserID','id','title'];
        if (!payload || typeof payload!=='object' || Array.isArray(payload) || Object.keys(payload).some(key=>!allowed.includes(key))
          || typeof payload.id!=='string' || (deleting ? payload.localOnlyConfirmed!==true : typeof payload.title!=='string'))
          throw Error(deleting ? 'Confirm that this action deletes only the local copy.' : 'Invalid recording title.');
        if (typeof store[deleting?'deleteRecording':'rename']!=='function') throw Error('Local recording management is unavailable.');
        const version=generation,key=`${id}:${payload.id}`,operation={label:deleting?'deleting':'renaming'};
        activeRecordingOperations.set(key,operation);emit();
        try {
          const args={ownerUserID:id,expectedOwnerUserID:id,id:payload.id,
            isCurrent:()=>version===generation&&auth.getProfile()?.userID===id,
            ...(deleting?{}:{title:payload.title})};
          if (deleting) await store.deleteRecording({...args,localOnlyConfirmed:true});
          else await store.rename(args);
          if (version!==generation || requireOwner()!==id) throw Error('The account changed. Refresh your recordings.');
        } finally { if(activeRecordingOperations.get(key)===operation) activeRecordingOperations.delete(key);emit(); }
      } else if(name==='stopRecording') { if(manualCapture?.isActive()) await manualCapture.stop(requireOwner(payload?.expectedOwnerUserID)); else await coordinator.cancel();emit(); }
      else if(name==='refresh') { cache=null;await pulse(); }
      else throw Error('Unknown Reel action.');
    }
    return transcriptResponse ?? state();
  }
  function dispose() {
    if(closed) return Promise.resolve();
    if(disposePromise) return disposePromise;
    closing=true;calendarController?.abort();auth?.cancelSignIn();processor?.cancel();
    disposePromise=(async()=>{
      // Consent mutations are durable before the process may exit.
      const cancellation=Promise.allSettled([coordinator?.cancel(),manualCapture?.dispose?.()]);
      // Keep the app process alive until native exporters release their input
      // and temporary output files; Electron's before-quit handler awaits us.
      await Promise.allSettled([...activeExports.values()]);
      try { await settingsTail; }
      catch {
        await cancellation;
        const failure=Error('Your latest recording settings have not been saved. Free disk space or restore access to your local files, then retry saving before quitting.');
        failure.code='settings_not_saved';throw failure;
      }
      await cancellation;await coordinator?.dispose();reminderScheduler?.dispose();
      processor?.dispose();closed=true;unsubscribeStatus?.();unsubscribeProcessing?.();unsubscribeAuth?.();
    })().catch(cause=>{closing=false;disposePromise=null;throw cause;});
    return disposePromise;
  }
  return {state,action,pulse,dispose};
}
