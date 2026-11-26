const api = window.reelDesktop;
const byId = id => document.getElementById(id);
const escText = value => String(value ?? '');
let snapshot = null;
let saving = false;
let localSettings = null;
let saveTimer = null;
let renderGeneration = 0;
let currentOwner = null;
let pendingSignIn = null;
let actionError = null;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = escText(text);
  return el;
}
function button(label, action, primary = true) {
  const el = node('button', primary ? 'primary' : 'outline', label);
  el.type = 'button'; el.dataset.action = action; return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function showError(message = '') {
  const banner = byId('banner'); banner.textContent = escText(message); banner.classList.toggle('hidden', !message);
}
function currentSettings() {
  const s = localSettings ?? snapshot?.settings ?? {};
  return { autoJoin: s.autoJoin === true, participantConsent: s.participantConsent === true,
    systemAudioConsent: s.systemAudioConsent === true,
    selection: { useAll: s.selection?.useAll === true, ids: Array.isArray(s.selection?.ids) ? [...s.selection.ids] : [] } };
}
function onboarding() {
  byId('setupView').classList.remove('hidden'); byId('dashboard').classList.add('hidden');
  byId('settingsShortcut').classList.add('hidden');
  const profile = snapshot?.profile;
  const step = !profile ? 1 : profile.calendarConnected ? 3 : 2;
  document.querySelectorAll('.steps li').forEach((el, i) => { el.classList.toggle('active', i + 1 === step); el.classList.toggle('done', i + 1 < step); });
  byId('stepEyebrow').textContent = `STEP ${step}`;
  byId('stepTitle').textContent = step === 1 ? 'Sign in with Google' : step === 2 ? 'Connect Google Calendar' : 'Confirm your choices';
  byId('stepDescription').textContent = step === 1 ? 'Use your existing work Google account to keep meetings and recordings tied to you.' : step === 2 ? 'Reel checks your upcoming meetings so you can choose which calendars to use.' : 'Review the recording permissions below, then save your setup.';
  const content = byId('stepContent'); clear(content);
  if (snapshot?.configured === false) {
    byId('stepTitle').textContent = 'Automatic meetings are not available';
    byId('stepDescription').textContent = 'Automatic meetings are not available in this build yet. Use the browser recorder to record a meeting.';
    return;
  }
  if (step === 1 || step === 2) {
    const start = button(pendingSignIn ? 'Waiting for Google…' : step === 1 ? 'Sign in with Google' : 'Connect Google Calendar', step === 1 ? 'signIn' : 'connectCalendar');
    start.disabled = Boolean(pendingSignIn);
    content.append(node('p', '', 'Sign in with your work Google account in the Chrome profile you use for meetings. If Chrome has multiple profiles, check the account in your meeting window.'), start);
    if (pendingSignIn) {
      const status = node('p', '', pendingSignIn.cancelling ? 'Cancelling…' : 'Complete the Google sign-in in Chrome, then return to Reel.');
      status.setAttribute('role', 'status');
      content.append(status);
      const cancel = button('Cancel', 'cancelSignIn', false);
      cancel.disabled = pendingSignIn.cancelling;
      content.append(cancel);
    }
  }
  else {
    const settings = currentSettings();
    content.append(consentControls(settings, false));
    const done = button('Save and continue', 'finishSetup'); done.disabled = !(settings.participantConsent && settings.systemAudioConsent); content.append(done);
  }
}
function consentControls(settings, dashboard) {
  const wrap = node('div');
  const participant = node('label','setting');
  const pbox = node('input'); pbox.type='checkbox'; pbox.dataset.setting='participantConsent'; pbox.checked=settings.participantConsent;
  const ptext=node('span'); ptext.append(node('strong', '', 'Participant consent')); ptext.append(node('small','','Participants in these calendars have agreed to meeting recording.'));
  participant.append(pbox,ptext); wrap.append(participant);
  const system=node('label','setting');
  const sbox=node('input'); sbox.type='checkbox'; sbox.dataset.setting='systemAudioConsent'; sbox.checked=settings.systemAudioConsent;
  const stext=node('span'); stext.append(node('strong','','Record meeting window video and all computer sound'));
  stext.append(node('small','','Reel captures the meeting window and all sound playing on this computer. Microphone and camera stay off. Recordings are saved locally and are not shared automatically.'));
  system.append(sbox,stext); wrap.append(system);
  if (dashboard) {
    const divider=node('div','divider'); wrap.append(divider);
    const label=node('p','calendar-heading','Calendars'); wrap.append(label);
    const group=node('div','calendar-options');
    const all=calendarCheckbox('All calendars', settings.selection.useAll, 'useAll'); group.append(all);
    const selected=new Set(settings.selection.ids);
    for (const cal of (snapshot?.calendars ?? [])) group.append(calendarCheckbox(cal.title || cal.id, selected.has(cal.id), cal.id));
    wrap.append(group);
    const enabled=!!snapshot?.profile?.calendarConnected && settings.participantConsent && settings.systemAudioConsent;
    const auto=node('label','setting'); const box=node('input'); box.type='checkbox'; box.dataset.setting='autoJoin'; box.checked=settings.autoJoin; box.disabled=!enabled;
    const text=node('span'); text.append(node('strong','','Automatically join and record eligible meetings'));
    text.append(node('small','',enabled?'Reel joins selected upcoming meetings and starts local capture.':'Connect your calendar and confirm both permissions to enable auto-join.'));
    auto.append(box,text); wrap.append(auto);
    if (snapshot?.startup) {
      wrap.append(node('div','divider'), node('p','calendar-heading','Start at Windows sign-in'));
      if (snapshot.startup.mode === 'windows-settings') {
        wrap.append(node('p','muted','Turn Reel Companion on or off in Windows Startup Apps. Windows shows the current setting.'));
        const button=node('button','outline','Open Windows Startup Apps');
        button.type='button'; button.dataset.action='openStartupSettings'; wrap.append(button);
      } else if (snapshot.startup.mode === 'portable') {
        const enabled=snapshot.startup.enabled===true;
        wrap.append(node('p','muted',enabled?'Reel Companion opens when you sign in to Windows.':'Reel Companion opens when you launch it.'));
        const button=node('button','outline',enabled?'Turn off start at sign-in':'Turn on start at sign-in');
        button.type='button'; button.dataset.action='setCompanionStartup';
        button.dataset.enabled=String(!enabled); wrap.append(button);
      }
    }
  }
  return wrap;
}
function calendarCheckbox(label, checked, value) {
  const row=node('label','calendar-option'); const input=node('input'); input.type='checkbox'; input.checked=checked; input.dataset.calendar=value;
  row.append(input,node('span','',label)); return row;
}
function renderDashboard() {
  byId('setupView').classList.add('hidden'); byId('dashboard').classList.remove('hidden'); byId('settingsShortcut').classList.remove('hidden');
  byId('welcome').textContent = snapshot.profile?.displayName ? `Signed in as ${snapshot.profile.displayName}.` : snapshot.profile?.email ?? '';
  byId('accountLabel').textContent = snapshot.profile?.email ?? '';
  const settings=byId('settingsContent'); clear(settings); settings.append(consentControls(currentSettings(),true));
  const phase=snapshot.status?.phase ?? 'idle'; byId('statusTitle').textContent=phaseLabel(phase);
  byId('statusMessage').textContent=snapshot.status?.message ?? (snapshot.profile?.calendarConnected?'Reel is checking your calendar.':'Connect a calendar to see upcoming meetings.');
  byId('stopButton').classList.toggle('hidden',phase!=='capturing');
  byId('stopButton').disabled = phase !== 'capturing';
  byId('stopButton').textContent = phase === 'saving' ? 'Saving recording…' : 'Stop and save recording';
  renderMeetings(); renderRecordings();
}
function phaseLabel(phase) { return ({capturing:'Recording your meeting',saving:'Saving your recording',close_required:'Close the meeting window manually to continue',completed:'Recording saved',joining:'Joining a meeting',scheduled:'Ready for your next meeting',calendar_unavailable:'Calendar needs attention',save_failed:'Could not save recording',failed:'Meeting could not start',retry_wait:'Retrying meeting connection',idle:'Waiting for your next meeting'})[phase] ?? 'Reel status'; }
function formatDate(value) { const d=new Date(value); return Number.isNaN(d.getTime())?escText(value):new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d); }
function renderMeetings() {
  const list=byId('meetingsList'); clear(list); const meetings=snapshot.meetings ?? [];
  if (!meetings.length) { list.append(node('p','empty','No upcoming meetings found.')); return; }
  for (const meeting of meetings) { const row=node('div','meeting-row'); const left=node('div'); left.append(node('div','meeting-name',meeting.title || 'Untitled meeting')); left.append(node('div','meeting-meta',meeting.platform || 'Meeting'));
    row.append(left,node('div','meeting-time',formatDate(meeting.start))); list.append(row); }
}
function renderRecordings() {
  const list=byId('recordingsList'); clear(list); const recordings=(snapshot.recordings ?? []);
  if (!recordings.length) { list.append(node('p','empty','Your saved recordings will appear here.')); return; }
  for (const recording of recordings) { const row=node('div','recording-row'); const left=node('div'); left.append(node('div','recording-name',recording.title || 'Recording'));
    const duration=Number.isFinite(recording.durationSeconds)?`${Math.floor(recording.durationSeconds/60)} min`:'';
    left.append(node('div','recording-meta',[formatDate(recording.createdAt),duration].filter(Boolean).join(' · ')));
    const play=node('button','','Play recording');
    play.type='button'; play.dataset.action='playRecording'; play.dataset.recordingId=recording.id; left.append(play);
    if(recording.processing) {
      if(recording.processing.transcriptReady) {
        const transcript=node('button','','Copy transcript');
        transcript.type='button'; transcript.dataset.action='copyTranscript'; transcript.dataset.recordingId=recording.id; left.append(transcript);
      }
      const labels={pending:'Waiting to process',transcribing:'Transcribing',summarizing:'Creating notes',delivering:'Delivering notes',completed:'Notes delivered',failed:'Processing failed'};
      left.append(node('div','recording-meta', recording.processing.noSpeech ? 'No speech detected' : (labels[recording.processing.phase] ?? 'Processing')));
      if(recording.processing.error) left.append(node('div','recording-meta',recording.processing.error));
      if(recording.processing.phase==='failed') { const button=node('button','','Retry notes'); button.type='button'; button.addEventListener('click',()=>void perform('retryProcessing',{id:recording.id,expectedOwnerUserID:snapshot.profile.userID})); left.append(button); }
      const sharing=recording.shareStatus;
      const shareButton=node('button','',recording.sharing?'Sharing…':sharing==='uploaded'?'Copy share link':sharing?.failed||sharing==='uploading'?(recording.shareIncludesTranscript?'Retry sharing video and transcript':'Retry sharing'):'Share recording');
      shareButton.type='button'; shareButton.disabled=recording.sharing===true; shareButton.dataset.action='shareRecording'; shareButton.dataset.recordingId=recording.id;
      left.append(shareButton);
      if (recording.processing.transcriptReady && !sharing) {
        const withTranscript = node('button', '', 'Share video and transcript');
        withTranscript.type = 'button';
        withTranscript.disabled = shareButton.disabled;
        withTranscript.dataset.action = 'shareRecording';
        withTranscript.dataset.recordingId = recording.id;
        withTranscript.dataset.includeTranscript = 'true';
        left.append(withTranscript);
      }
      if(sharing?.failed) left.append(node('div','recording-meta','Sharing failed. Select Retry sharing to try again.'));
    }
    row.append(left); list.append(row); }
}
function render() {
  showError(actionError ?? snapshot?.error ?? '');
  if (snapshot?.configured === false && !snapshot.profile) { snapshot.profile=null; }
  const settings=snapshot?.settings;
  const consented=settings?.participantConsent === true && settings?.systemAudioConsent === true;
  if (snapshot?.configured !== false && snapshot?.profile?.calendarConnected && consented) renderDashboard(); else onboarding();
}
function applySnapshot(next, expectedGeneration = null) {
  if (!next || (expectedGeneration !== null && expectedGeneration !== renderGeneration)) return;
  const owner=next.profile?.userID ?? null;
  if (owner !== currentOwner || (snapshot?.profile?.calendarConnected === true && next.profile?.calendarConnected !== true)) {
    clearTimeout(saveTimer); saveTimer=null; saving=false; localSettings=null; renderGeneration++;
    pendingSignIn=null;
    actionError=null;
    currentOwner=owner;
  }
  snapshot=next;
  render();
}
async function perform(name,payload) {
  if (snapshot?.configured === false && ['signIn','connectCalendar','cancelSignIn','signOut','disconnectCalendar','saveSettings'].includes(name)) return;
  const isSignIn = name === 'signIn' || name === 'connectCalendar';
  if (isSignIn && pendingSignIn) return;
  const signIn = isSignIn ? { cancelling: false } : null;
  const cancellingSignIn = name === 'cancelSignIn' ? pendingSignIn : null;
  if (signIn) { pendingSignIn=signIn; render(); }
  if (name === 'cancelSignIn' && pendingSignIn) {
    if (pendingSignIn.cancelling) return;
    pendingSignIn.cancelling=true;
    render();
  }
  if (name === 'signOut' || name === 'disconnectCalendar') {
    clearTimeout(saveTimer); saveTimer=null; localSettings=null; saving=false; renderGeneration++;
    byId('saveState').textContent='';
  }
  const generation=renderGeneration;
  try {
    actionError=null;
    showError('');
    const next=await api.action(name,payload);
    // Cancellation changes no public profile; its response may arrive after a new attempt starts.
    if (next && name !== 'cancelSignIn') applySnapshot(next,generation);
  }
  catch (error) {
    if (cancellingSignIn && pendingSignIn === cancellingSignIn) {
      cancellingSignIn.cancelling=false;
      render();
    }
    if (generation === renderGeneration && (!cancellingSignIn || pendingSignIn === cancellingSignIn)
      && (!signIn || (pendingSignIn === signIn && !signIn.cancelling))) {
      actionError=error?.message || 'That action could not be completed. Please try again.';
      showError(actionError);
    }
  }
  finally {
    if (signIn && pendingSignIn === signIn) {
      pendingSignIn=null;
      // Preserve an action error while restoring the sign-in controls.
      const message=byId('banner').textContent;
      render();
      if (message) showError(message);
    }
  }
}
function collectSettings() {
  const settings=currentSettings();
  document.querySelectorAll('[data-setting]').forEach(input=>settings[input.dataset.setting]=input.checked);
  const useAll=document.querySelector('[data-calendar="useAll"]');
  if (useAll) {
    settings.selection.useAll=useAll.checked;
    settings.selection.ids=[...document.querySelectorAll('[data-calendar]:not([data-calendar="useAll"]):checked')].map(input=>input.dataset.calendar);
  }
  return settings;
}
function scheduleSave() {
  if (snapshot?.configured === false || !snapshot?.profile?.calendarConnected) return;
  localSettings=collectSettings();
  if (!localSettings.participantConsent || !localSettings.systemAudioConsent) localSettings.autoJoin=false;
  byId('saveState').textContent='Saving…'; saving=true; clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{
    const payload={...localSettings,expectedOwnerUserID:snapshot?.profile?.userID};
    const generation=renderGeneration;
    try { actionError=null; const next=await api.action('saveSettings',payload); if(next) applySnapshot(next,generation); if(generation===renderGeneration) { byId('saveState').textContent='Saved'; showError(snapshot?.error??''); } }
    catch(error){ if(generation===renderGeneration) { byId('saveState').textContent=''; actionError=error?.message||'Could not save settings.'; showError(actionError); } }
    finally { if(generation===renderGeneration) { saving=false; localSettings=null; render(); } }
  },250);
}
document.addEventListener('click', event=>{
  const scroller=event.target.closest('[data-scroll]'); if(scroller) { document.querySelector(`.${scroller.dataset.scroll}`)?.scrollIntoView({behavior:'smooth'}); return; }
  const target=event.target.closest('[data-action]'); if(!target || target.disabled) return;
  const action=target.dataset.action;
  if(action==='finishSetup') { const settings=collectSettings(); if(settings.participantConsent&&settings.systemAudioConsent) perform('saveSettings',{...settings,expectedOwnerUserID:snapshot?.profile?.userID}); return; }
  if(action==='playRecording'||action==='copyTranscript') { perform(action,{id:target.dataset.recordingId,expectedOwnerUserID:snapshot?.profile?.userID}); return; }
  if(action==='setCompanionStartup') { perform(action,{enabled:target.dataset.enabled==='true'}); return; }
  if(action==='shareRecording') { perform(action,{id:target.dataset.recordingId,expectedOwnerUserID:snapshot?.profile?.userID,...(target.dataset.includeTranscript==='true'?{includeTranscript:true}:{})}); return; }
  perform(action);
});
document.addEventListener('change', event=>{ if(event.target.matches('[data-setting],[data-calendar]')) scheduleSave(); });
if (api?.onState) api.onState(next=>applySnapshot(next));
if (api?.state) { const initialGeneration=renderGeneration; api.state().then(next=>applySnapshot(next,initialGeneration)).catch(error=>showError(error?.message||'Reel could not load its current state.')); }
