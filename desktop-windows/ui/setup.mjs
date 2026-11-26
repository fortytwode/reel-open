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
let pendingJoin = false;
let microphoneMeetingId = null;
let pendingReminderMeetingID = null;
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
    systemAudioConsent: s.systemAudioConsent === true, meetingReminders: s.meetingReminders === true,
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
  stext.append(node('small','','Reel captures the meeting window and all sound playing on this computer. The microphone is optional when you start a meeting yourself. The camera stays off. Recordings are saved locally and are not shared automatically.'));
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
    const reminder=node('label','setting'); const reminderBox=node('input'); reminderBox.type='checkbox';
    reminderBox.dataset.setting='meetingReminders'; reminderBox.checked=settings.meetingReminders;
    const reminderText=node('span'); reminderText.append(node('strong','','Prompt when a calendar meeting starts'));
    reminderText.append(node('small','','Show a local Windows notification at meeting start. Reel will not join or record from this reminder.'));
    reminder.append(reminderBox,reminderText); wrap.append(reminder);
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
  const settings=byId('settingsContent'); clear(settings); settings.append(consentControls(currentSettings(),true));
  const phase=snapshot.status?.phase ?? 'idle'; byId('statusTitle').textContent=phaseLabel(phase);
  byId('statusMessage').textContent=snapshot.status?.message ?? (snapshot.profile?.calendarConnected?'Reel is checking your calendar.':'Connect a calendar to see upcoming meetings.');
  byId('cancelJoinButton').classList.toggle('hidden', phase !== 'joining');
  byId('stopButton').classList.toggle('hidden',phase!=='capturing');
  byId('stopButton').disabled = phase !== 'capturing';
  byId('stopButton').textContent = phase === 'saving' ? 'Saving recording…' : 'Stop and save recording';
  renderMeetings();
}
function phaseLabel(phase) { return ({capturing:'Recording your meeting',cancelled:'Meeting join cancelled',saving:'Saving your recording',close_required:'Close the meeting window manually to continue',completed:'Recording saved',joining:'Joining a meeting',scheduled:'Ready for your next meeting',calendar_unavailable:'Calendar needs attention',save_failed:'Could not save recording',failed:'Meeting could not start',retry_wait:'Retrying meeting connection',idle:'Waiting for your next meeting'})[phase] ?? 'Reel status'; }
function formatDate(value) { const d=new Date(value); return Number.isNaN(d.getTime())?escText(value):new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d); }
function joinBusy() {
  return pendingJoin || saving || ['joining', 'capturing', 'saving', 'close_required', 'retry_wait'].includes(snapshot?.status?.phase);
}
function renderMeetings() {
  const list=byId('meetingsList'); clear(list); const meetings=snapshot.meetings ?? [];
  if (!meetings.length) { list.append(node('p','empty','No upcoming meetings found.')); return; }
  const busy = joinBusy();
  for (const meeting of meetings) {
    const row = node('div', 'meeting-row');
    const details = node('div');
    details.append(node('div', 'meeting-name', meeting.title || 'Untitled meeting'),
      node('div', 'meeting-meta', meeting.platform || 'Meeting'));
    const actions = node('div', 'meeting-actions');
    const join = button('Join & record', 'joinMeeting', false);
    join.dataset.meetingId = meeting.id;
    join.disabled = busy;
    join.setAttribute('aria-label', `Join & record ${meeting.title || 'meeting'}`);
    const micLabel = node('label', 'setting');
    const mic = node('input');
    mic.type = 'checkbox';
    mic.dataset.microphoneMeetingId = meeting.id;
    mic.checked = microphoneMeetingId === meeting.id;
    mic.disabled = busy;
    mic.setAttribute('aria-label', `Include my microphone for ${meeting.title || 'this meeting'}`);
    micLabel.append(mic, node('span', '', 'Include my microphone'));
    actions.append(node('div', 'meeting-time', formatDate(meeting.start)), micLabel, join);
    row.append(details, actions);
    list.append(row);
  }
  focusReminderMeeting();
}
function focusReminderMeeting(id = pendingReminderMeetingID) {
  if(typeof id==='string' && id) pendingReminderMeetingID=id;
  if(!pendingReminderMeetingID) return;
  const target=[...document.querySelectorAll('[data-meeting-id]')].find(element=>element.dataset.meetingId===pendingReminderMeetingID);
  if(target) { pendingReminderMeetingID=null; target.scrollIntoView({behavior:'smooth',block:'center'}); target.focus(); }
}
function renderRecordings() {
  const list=byId('recordingsList'); clear(list); const recordings=(snapshot.recordings ?? []);
  if (!recordings.length) { list.append(node('p','empty','Your saved recordings will appear here.')); return; }
  for (const recording of recordings) { const row=node('div','recording-row'); const left=node('div'); left.append(node('div','recording-name',recording.title || 'Recording'));
    const duration=Number.isFinite(recording.durationSeconds)?`${Math.floor(recording.durationSeconds/60)} min`:'';
    left.append(node('div','recording-meta',[formatDate(recording.createdAt),duration].filter(Boolean).join(' · ')));
    const play=node('button','','Play recording');
    play.type='button'; play.dataset.action='playRecording'; play.dataset.recordingId=recording.id; left.append(play);
    const trimControls=node('div','trim-export-controls');
    const startLabel=node('label','trim-export-setting','Start (seconds)');
    const start=node('input'); start.type='number'; start.min='0'; start.max=String(recording.durationSeconds); start.step='0.001'; start.value='0'; start.setAttribute('aria-label',`Trim start for ${recording.title || 'recording'}`); startLabel.append(start);
    const endLabel=node('label','trim-export-setting','End (seconds)');
    const end=node('input'); end.type='number'; end.min='0'; end.max=String(recording.durationSeconds); end.step='0.001'; end.value=String(recording.durationSeconds); end.setAttribute('aria-label',`Trim end for ${recording.title || 'recording'}`); endLabel.append(end);
    const trim=node('button','','Trim & export…'); trim.type='button';
    trim.addEventListener('click',()=>{
      start.value=start.value.trim(); end.value=end.value.trim();
      if(!start.value || !end.value || !start.checkValidity() || !end.checkValidity()) { start.reportValidity(); end.reportValidity(); return; }
      trim.disabled=true;
      void perform('exportTrimmedCopy',{id:recording.id,expectedOwnerUserID:snapshot.profile?.userID,start:Number(start.value),end:Number(end.value)})
        .finally(()=>{ trim.disabled=false; });
    });
    trimControls.append(node('div','recording-meta','Exports a separate MP4. The original stays unchanged.'),startLabel,endLabel,trim); left.append(trimControls);
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
      const accessUpdatePending=recording.shareAccess?.updatePending===true;
      const shareButton=node('button','',recording.sharing?'Sharing…':accessUpdatePending?'Link update pending':sharing==='uploaded'?'Copy share link':sharing?.failed||sharing==='uploading'?(recording.shareIncludesTranscript?'Retry sharing video and transcript':'Retry sharing'):'Share recording');
      shareButton.type='button'; shareButton.disabled=recording.sharing===true||accessUpdatePending; shareButton.dataset.action='shareRecording'; shareButton.dataset.recordingId=recording.id;
      const initialShare = !sharing;
      let sharePassword = null, shareExpiry = null, updateButton = null;
      if (initialShare) {
        const passwordLabel = node('label', 'recording-share-setting', 'Password (optional; at least 12 characters)');
        sharePassword = node('input'); sharePassword.type = 'password'; sharePassword.autocomplete = 'off';
        sharePassword.maxLength = 1024; sharePassword.minLength = 12; sharePassword.dataset.sharePassword = recording.id;
        passwordLabel.append(sharePassword);
        const expiryLabel = node('label', 'recording-share-setting', 'Link expires');
        shareExpiry = node('select'); shareExpiry.dataset.shareExpiry = recording.id;
        for (const [value, label] of [['never', 'Never'], ['hour', 'In 1 hour'], ['day', 'In 1 day'], ['week', 'In 1 week'], ['month', 'In 30 days']]) {
          const option = node('option', '', label); option.value = value; shareExpiry.append(option);
        }
        expiryLabel.append(shareExpiry);
        left.append(passwordLabel, expiryLabel);
      } else if (sharing === 'uploaded' || recording.shareAccess?.updatePending) {
        const access=recording.shareAccess ?? {};
        left.append(node('div','recording-meta',`${access.passwordProtected?'Password protected':'No password'} · ${access.expiresAt?`expires ${new Date(access.expiresAt).toLocaleString()}`:'never expires'}`));
        if(access.updatePending) left.append(node('div','recording-meta','The previous link may remain accessible until this update succeeds. Retry to finish applying the new settings.'));
        const passwordLabel=node('label','recording-share-setting','New password (leave blank to keep current; at least 12 characters)');
        sharePassword=node('input');sharePassword.type='password';sharePassword.autocomplete='new-password';sharePassword.maxLength=1024;
        sharePassword.minLength=12;sharePassword.dataset.sharePassword=recording.id;passwordLabel.append(sharePassword);
        const removeLabel=node('label','recording-share-setting','Remove password');
        const removePassword=node('input');removePassword.type='checkbox';removePassword.dataset.removeSharePassword=recording.id;removeLabel.append(removePassword);
        const expiryLabel=node('label','recording-share-setting','Link expiry');
        shareExpiry=node('select');shareExpiry.dataset.shareExpiry=recording.id;
        for(const [value,label] of [['keep','Keep current'],['never','Never'],['hour','In 1 hour'],['day','In 1 day'],['week','In 1 week'],['month','In 30 days']]) {
          const option=node('option','',label);option.value=value;shareExpiry.append(option);
        }
        expiryLabel.append(shareExpiry);
        left.append(passwordLabel,removeLabel,expiryLabel);
        updateButton=node('button','',recording.sharing?'Updating link…':access.updatePending?'Retry link settings update':'Update link settings');
        updateButton.type='button';updateButton.disabled=recording.sharing===true;updateButton.dataset.action='updateMeetingShareAccess';
        updateButton.dataset.recordingId=recording.id;updateButton.sharePasswordInput=sharePassword;
        updateButton.shareExpiryInput=shareExpiry;updateButton.removePasswordInput=removePassword;
      }
      shareButton.sharePasswordInput = initialShare ? sharePassword : null;
      shareButton.shareExpiryInput = initialShare ? shareExpiry : null;
      left.append(shareButton);
      if(updateButton) left.append(updateButton);
      if (recording.processing.transcriptReady && !sharing) {
        const withTranscript = node('button', '', 'Share video and transcript');
        withTranscript.type = 'button';
        withTranscript.disabled = shareButton.disabled;
        withTranscript.dataset.action = 'shareRecording';
        withTranscript.dataset.recordingId = recording.id;
        withTranscript.dataset.includeTranscript = 'true';
        withTranscript.sharePasswordInput = sharePassword; withTranscript.shareExpiryInput = shareExpiry;
        left.append(withTranscript);
      }
      if(sharing?.failed) left.append(node('div','recording-meta','Sharing failed. Select Retry sharing to try again.'));
    }
    if (recording.localOperation) left.append(node('div','recording-meta',recording.localOperation==='deleting'?'Deleting local copy…':'Saving title…'));
    const rename=node('button','','Rename'); rename.type='button'; rename.dataset.action='renameRecording'; rename.dataset.recordingId=recording.id;
    rename.disabled=recording.localOperation==='deleting'; left.append(rename);
    const remove=node('button','','Delete local copy'); remove.type='button'; remove.dataset.action='deleteRecording'; remove.dataset.recordingId=recording.id;
    remove.disabled=recording.localOperation==='deleting'; left.append(remove);
    row.append(left); list.append(row); }
}
function render() {
  showError(actionError ?? snapshot?.error ?? '');
  if (snapshot?.configured === false && !snapshot.profile) { snapshot.profile=null; }
  const settings=snapshot?.settings;
  const consented=settings?.participantConsent === true && settings?.systemAudioConsent === true;
  const signedIn = snapshot?.configured !== false && Boolean(snapshot?.profile?.userID);
  const dashboard = signedIn && snapshot.profile.calendarConnected && consented;
  const phase = snapshot?.status?.phase;
  byId('manualMeeting').classList.toggle('hidden', !signedIn);
  byId('joinMeetingLink').disabled = joinBusy();
  byId('manualMeetingStatus').classList.toggle('hidden', !signedIn || dashboard || !phase || phase === 'idle');
  byId('manualMeetingMessage').textContent = snapshot?.status?.message ?? '';
  byId('manualCancel').classList.toggle('hidden', phase !== 'joining');
  byId('manualStop').classList.toggle('hidden', phase !== 'capturing');
  if (dashboard) renderDashboard(); else onboarding();
  const showRecordings = signedIn && (dashboard || snapshot.recordings?.length > 0);
  byId('recordingsCard').classList.toggle('hidden', !showRecordings);
  if (showRecordings) renderRecordings();
  else clear(byId('recordingsList'));
  byId('accountRow').classList.toggle('hidden', !signedIn);
  byId('accountLabel').textContent = snapshot?.profile?.email ?? '';
  byId('disconnectCalendarButton').classList.toggle('hidden', !snapshot?.profile?.calendarConnected);
}
function applySnapshot(next, expectedGeneration = null) {
  if (!next || (expectedGeneration !== null && expectedGeneration !== renderGeneration)) return;
  const owner=next.profile?.userID ?? null;
  if (owner !== currentOwner || (snapshot?.profile?.calendarConnected === true && next.profile?.calendarConnected !== true)) {
    clearTimeout(saveTimer); saveTimer=null; saving=false; localSettings=null; renderGeneration++;
    pendingSignIn=null;
    pendingJoin=false;
    microphoneMeetingId=null;
    pendingReminderMeetingID=null;
    clearMeetingLink();
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
  microphoneMeetingId=null;
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
  if (action === 'joinMeeting') {
    const id = target.dataset.meetingId;
    void startMeeting(action, { id, includeMicrophone: microphoneMeetingId === id });
    return;
  }
  if (action === 'cancelJoin') {
    void perform(action, {expectedOwnerUserID:snapshot?.profile?.userID});
    return;
  }
  if(action==='shareRecording') {
    const password = target.sharePasswordInput?.value ?? '';
    const expiry = target.shareExpiryInput?.value ?? 'never';
    const payload = { id:target.dataset.recordingId, expectedOwnerUserID:snapshot?.profile?.userID,
      ...(target.dataset.includeTranscript==='true'?{includeTranscript:true}:{}), ...(password?{password}:{}), ...(expiry!=='never'?{expiry}:{}) };
    void perform(action,payload).finally(()=>{ if(target.sharePasswordInput) target.sharePasswordInput.value=''; });
    return;
  }
  if(action==='updateMeetingShareAccess') {
    const password=target.sharePasswordInput?.value??'';
    const expiry=target.shareExpiryInput?.value??'keep';
    const payload={id:target.dataset.recordingId,expectedOwnerUserID:snapshot?.profile?.userID,
      ...(password?{password}:{}),...(target.removePasswordInput?.checked?{removePassword:true}:{}),...(expiry!=='keep'?{expiry}:{})};
    void perform(action,payload).finally(()=>{if(target.sharePasswordInput)target.sharePasswordInput.value='';});
    return;
  }
  if(action==='renameRecording') {
    const recording=(snapshot.recordings??[]).find(item=>item.id===target.dataset.recordingId);
    if (!recording) return;
    const title=window.prompt('Rename saved recording',recording.title||'Recording');
    if(title!==null) void perform(action,{id:recording.id,title,expectedOwnerUserID:snapshot.profile.userID});
    return;
  }
  if(action==='deleteRecording') {
    const recording=(snapshot.recordings??[]).find(item=>item.id===target.dataset.recordingId);
    if (!recording || !window.confirm(`Delete “${recording.title||'Recording'}” from this computer? This removes the local recording only. Any cloud share link remains available.`)) return;
    void perform(action,{id:recording.id,localOnlyConfirmed:true,expectedOwnerUserID:snapshot.profile.userID});
    return;
  }
  perform(action);
});
function clearMeetingLink() {
  byId('meetingLink').value = '';
  byId('meetingLinkConsent').checked = false;
  byId('meetingLinkMicrophone').checked = false;
  byId('manualMeeting').open = false;
}
async function startMeeting(action, payload) {
  if (joinBusy() || !snapshot?.profile?.userID) return;
  if (action === 'joinMeeting' && (!snapshot.settings?.participantConsent || !snapshot.settings?.systemAudioConsent)) return;
  microphoneMeetingId = null;
  clearMeetingLink();
  pendingJoin = true;
  render();
  const generation = renderGeneration;
  try { await perform(action, { ...payload, expectedOwnerUserID:snapshot.profile.userID }); }
  finally {
    if (generation === renderGeneration) {
      pendingJoin = false;
      render();
    }
  }
}
document.addEventListener('change', event => {
  if (event.target.matches('[data-microphone-meeting-id]')) {
    microphoneMeetingId = event.target.checked ? event.target.dataset.microphoneMeetingId : null;
    for (const option of document.querySelectorAll('[data-microphone-meeting-id]')) {
      option.checked = option.dataset.microphoneMeetingId === microphoneMeetingId;
    }
  }
  if (event.target.matches('[data-setting],[data-calendar]')) scheduleSave();
});
document.addEventListener('submit', event => {
  if (event.target.id !== 'meetingLinkForm') return;
  event.preventDefault();
  const url = byId('meetingLink').value.trim();
  const participantsConfirmed = byId('meetingLinkConsent').checked;
  if (!url || !participantsConfirmed) return;
  void startMeeting('joinMeetingLink', { url, participantsConfirmed, includeMicrophone: byId('meetingLinkMicrophone').checked });
});
if (api?.onState) api.onState(next=>applySnapshot(next));
if (api?.onMeetingReminder) api.onMeetingReminder(focusReminderMeeting);
if (api?.state) { const initialGeneration=renderGeneration; api.state().then(next=>applySnapshot(next,initialGeneration)).catch(error=>showError(error?.message||'Reel could not load its current state.')); }
