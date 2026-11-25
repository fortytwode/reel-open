"""Team workspace layered on canonical meeting notes.

The canonical note (summary, transcript, recipients) is written once by
delivery and never changes. Everything people do with a note afterwards lives
here: who else may read it, ticked and added action items, an edited summary,
each reader's private notes, and each reader's folders.
"""
import hashlib
import json
import re
import uuid

from reel_organization import is_internal_email

MAX_SHARED = 200
MAX_TASKS = 200
MAX_TASK_CHARS = 500
MAX_SUMMARY_CHARS = 40_000
MAX_PRIVATE_CHARS = 20_000
MAX_FOLDERS = 100
MAX_FOLDER_NAME = 80
LINK_ACCESS = ('invited', 'organization')
ROLES = ('editor', 'viewer')
MEETING_ID = re.compile(r'reel_[0-9a-f]{64}')
FOLDER_ID = re.compile(r'[0-9a-f]{32}')
MAX_SHARED_FOLDERS = 100
MAX_FOLDER_MEMBERS = 100
MAX_FOLDER_MEETINGS = 2000
MAX_PROMPTS = 50
MAX_PROMPT_CHARS = 1000
MAX_PROMPT_TITLE = 60
PROMPT_SCOPES = ('all', 'note')
MAX_TOKENS = 10


class WorkspaceError(Exception):
    """A request the workspace refuses; the message is safe to return."""


def _digest(value):
    return hashlib.sha256(json.dumps([value], separators=(',', ':')).encode()).hexdigest()


def extra_key(meeting_id):
    return 'notes-workspace/' + meeting_id


def user_key(email):
    return 'notes-user/' + _digest(email)


def _update(store, key, normalize, change):
    """Apply change() to the stored document, retrying when someone else wrote first."""
    from google.api_core.exceptions import PreconditionFailed
    for _ in range(20):
        raw, generation = store.load(key)
        state = normalize(raw)
        result = change(state)
        try:
            store.cas(key, state, generation)
            return result if result is not None else state
        except PreconditionFailed:
            continue
    raise WorkspaceError('The note changed repeatedly; try again')


def _text(value, limit):
    return isinstance(value, str) and len(value) <= limit and '\x00' not in value


def normalize_extra(raw):
    raw = raw if isinstance(raw, dict) else {}
    tasks = raw.get('tasks') if isinstance(raw.get('tasks'), dict) else {}
    added = raw.get('added') if isinstance(raw.get('added'), list) else []
    summary = raw.get('summary') if isinstance(raw.get('summary'), dict) else None
    shared = [email for email in raw.get('shared_with', []) if isinstance(email, str)] if isinstance(raw.get('shared_with'), list) else []
    roles = raw.get('roles') if isinstance(raw.get('roles'), dict) else {}
    folder_members = raw.get('folder_members') if isinstance(raw.get('folder_members'), dict) else {}
    return {
        # Access that comes from shared folders: {email: {folder_id: role}}.
        'folder_members': {email: {folder: role for folder, role in grants.items() if FOLDER_ID.fullmatch(str(folder)) and role in ROLES}
                           for email, grants in folder_members.items() if isinstance(email, str) and isinstance(grants, dict) and grants},
        # People invited before roles existed could edit, so editor stays the default.
        'roles': {email: roles.get(email) if roles.get(email) in ROLES else 'editor' for email in shared[:MAX_SHARED]},
        'tasks': {text: state for text, state in tasks.items() if _text(text, MAX_TASK_CHARS) and isinstance(state, dict)},
        'added': [task for task in added if isinstance(task, dict) and _text(task.get('text'), MAX_TASK_CHARS) and isinstance(task.get('id'), str)],
        'summary': summary if summary and _text(summary.get('text'), MAX_SUMMARY_CHARS) else None,
        'shared_with': shared[:MAX_SHARED],
        'link_access': raw.get('link_access') if raw.get('link_access') in LINK_ACCESS else 'invited',
    }


def normalize_user(raw):
    raw = raw if isinstance(raw, dict) else {}
    folders = [folder for folder in raw.get('folders', []) if isinstance(folder, dict) and FOLDER_ID.fullmatch(str(folder.get('id')))
               and _text(folder.get('name'), MAX_FOLDER_NAME)] if isinstance(raw.get('folders'), list) else []
    ids = {folder['id'] for folder in folders}
    placed = raw.get('meeting_folders') if isinstance(raw.get('meeting_folders'), dict) else {}
    notes = raw.get('notes') if isinstance(raw.get('notes'), dict) else {}
    shared_folders = [folder for folder in raw.get('shared_folders', []) if FOLDER_ID.fullmatch(str(folder))] if isinstance(raw.get('shared_folders'), list) else []
    prompts = [prompt for prompt in raw.get('prompts', []) if isinstance(prompt, dict) and FOLDER_ID.fullmatch(str(prompt.get('id')))
               and _text(prompt.get('title'), MAX_PROMPT_TITLE) and _text(prompt.get('text'), MAX_PROMPT_CHARS)
               and prompt.get('scope') in PROMPT_SCOPES] if isinstance(raw.get('prompts'), list) else []
    tokens = [token for token in raw.get('mcp_tokens', []) if isinstance(token, dict) and isinstance(token.get('id'), str)
              and _text(token.get('label'), 60)] if isinstance(raw.get('mcp_tokens'), list) else []
    return {
        'shared_folders': list(dict.fromkeys(shared_folders))[:MAX_SHARED_FOLDERS],
        'prompts': prompts[:MAX_PROMPTS],
        'mcp_tokens': tokens[:MAX_TOKENS],
        'folders': folders[:MAX_FOLDERS],
        'meeting_folders': {meeting: folder for meeting, folder in placed.items() if MEETING_ID.fullmatch(meeting) and folder in ids},
        'notes': {meeting: text for meeting, text in notes.items() if MEETING_ID.fullmatch(meeting) and _text(text, MAX_PRIVATE_CHARS)},
    }


def load_extra(store, meeting_id):
    return normalize_extra(store.load(extra_key(meeting_id))[0])


def load_user(store, email):
    return normalize_user(store.load(user_key(email))[0])


def access_level(note, extra, email):
    """recipient: was in the meeting. shared: invited afterwards. organization: has the link."""
    if email in note['recipients']:
        return 'recipient'
    if email in extra['shared_with'] or extra['folder_members'].get(email):
        return 'shared'
    if extra['link_access'] == 'organization' and is_internal_email(email):
        return 'organization'
    return None


def set_task(store, meeting_id, email, text, done, now):
    if not _text(text, MAX_TASK_CHARS) or not text.strip() or not isinstance(done, bool):
        raise WorkspaceError('Invalid action item')

    def change(state):
        for task in state['added']:
            if task['id'] == text:
                task.update(done=done, by=email, at=now)
                return
        if text not in state['tasks'] and len(state['tasks']) >= MAX_TASKS:
            raise WorkspaceError('Too many action items')
        state['tasks'][text] = {'done': done, 'by': email, 'at': now}
    return _update(store, extra_key(meeting_id), normalize_extra, change)


def add_task(store, meeting_id, email, text, now):
    text = ' '.join(text.split()) if isinstance(text, str) else ''
    if not text or len(text) > MAX_TASK_CHARS:
        raise WorkspaceError('Invalid action item')

    def change(state):
        if len(state['added']) >= MAX_TASKS:
            raise WorkspaceError('Too many action items')
        state['added'].append({'id': uuid.uuid4().hex, 'text': text, 'done': False, 'by': email, 'at': now})
    return _update(store, extra_key(meeting_id), normalize_extra, change)


def remove_task(store, meeting_id, task_id):
    def change(state):
        state['added'] = [task for task in state['added'] if task['id'] != task_id]
    return _update(store, extra_key(meeting_id), normalize_extra, change)


def set_summary(store, meeting_id, email, text, now, generated=None):
    """text=None restores the summary the notetaker wrote. generated records how a rewrite was made."""
    if text is not None and (not _text(text, MAX_SUMMARY_CHARS) or not text.strip()):
        raise WorkspaceError('Invalid summary')

    def change(state):
        state['summary'] = None if text is None else {'text': text.strip(), 'by': email, 'at': now,
                                                      **({'generated': generated} if generated else {})}
    return _update(store, extra_key(meeting_id), normalize_extra, change)


def share(store, meeting_id, note, add=(), remove=(), link_access=None, role='editor', roles=None):
    add = [str(email).strip().lower() for email in add]
    roles = {str(email).strip().lower(): value for email, value in (roles or {}).items()}
    if role not in ROLES or any(value not in ROLES for value in roles.values()):
        raise WorkspaceError('Invalid role')
    remove = [str(email).strip().lower() for email in remove]
    if any(not is_internal_email(email) for email in add):
        raise WorkspaceError('Notes can be shared only inside your organization')
    if link_access is not None and link_access not in LINK_ACCESS:
        raise WorkspaceError('Invalid link access')

    def change(state):
        shared = [email for email in state['shared_with'] if email not in remove]
        for email in add:
            if email not in shared and email not in note['recipients']:
                shared.append(email)
        if len(shared) > MAX_SHARED:
            raise WorkspaceError('Too many people')
        state['shared_with'] = shared
        state['roles'] = {email: roles.get(email) or (role if email in add else state['roles'].get(email, 'editor')) for email in shared}
        if link_access is not None:
            state['link_access'] = link_access
    return _update(store, extra_key(meeting_id), normalize_extra, change)


def set_private_note(store, email, meeting_id, text):
    if not _text(text, MAX_PRIVATE_CHARS):
        raise WorkspaceError('Invalid note')

    def change(state):
        if text.strip():
            state['notes'][meeting_id] = text
        else:
            state['notes'].pop(meeting_id, None)
    return _update(store, user_key(email), normalize_user, change)


def _folder_name(name):
    name = ' '.join(name.split()) if isinstance(name, str) else ''
    if not name or len(name) > MAX_FOLDER_NAME:
        raise WorkspaceError('Invalid folder name')
    return name


def create_folder(store, email, name):
    name = _folder_name(name)

    def change(state):
        if len(state['folders']) >= MAX_FOLDERS:
            raise WorkspaceError('Too many folders')
        state['folders'].append({'id': uuid.uuid4().hex, 'name': name})
    return _update(store, user_key(email), normalize_user, change)


def rename_folder(store, email, folder_id, name):
    name = _folder_name(name)

    def change(state):
        for folder in state['folders']:
            if folder['id'] == folder_id:
                folder['name'] = name
                return
        raise WorkspaceError('Folder not found')
    return _update(store, user_key(email), normalize_user, change)


def delete_folder(store, email, folder_id):
    def change(state):
        state['folders'] = [folder for folder in state['folders'] if folder['id'] != folder_id]
        state['meeting_folders'] = {meeting: folder for meeting, folder in state['meeting_folders'].items() if folder != folder_id}
    return _update(store, user_key(email), normalize_user, change)


def place_in_folder(store, email, meeting_id, folder_id):
    def change(state):
        if folder_id is None:
            state['meeting_folders'].pop(meeting_id, None)
        elif folder_id in {folder['id'] for folder in state['folders']}:
            state['meeting_folders'][meeting_id] = folder_id
        else:
            raise WorkspaceError('Folder not found')
    return _update(store, user_key(email), normalize_user, change)


def shared_role(extra, email):
    """A direct invitation's role wins; otherwise editor if any shared folder grants it."""
    if email in extra['shared_with']:
        return extra['roles'].get(email, 'editor')
    grants = extra['folder_members'].get(email, {}).values()
    return 'editor' if 'editor' in grants else 'viewer' if grants else None


def view(note, extra, user, level, email=''):
    """What one reader sees of the workspace for one note."""
    meeting_id = note['id']
    return {
        'access': level,
        # People who were invited can change the shared state; link viewers only read.
        'can_edit': level == 'recipient' or (level == 'shared' and shared_role(extra, email) == 'editor'),
        'role': 'owner' if level == 'recipient' else shared_role(extra, email) if level == 'shared' else 'viewer',
        'can_share': level == 'recipient',
        'tasks': extra['tasks'],
        'added_tasks': extra['added'],
        'summary': extra['summary'],
        'shared_with': extra['shared_with'] if level != 'organization' else [],
        'roles': extra['roles'] if level != 'organization' else {},
        'link_access': extra['link_access'],
        'my_notes': user['notes'].get(meeting_id, ''),
        'folder_id': user['meeting_folders'].get(meeting_id),
        'shared_folder_ids': sorted({folder for grants in extra['folder_members'].values() for folder in grants}),
    }


# ---- Shared folders: a named set of meetings opened to a group of colleagues ----

def folder_key(folder_id):
    return 'notes-folders/' + folder_id


def normalize_folder(raw):
    raw = raw if isinstance(raw, dict) else {}
    members = raw.get('members') if isinstance(raw.get('members'), dict) else {}
    meetings = raw.get('meetings') if isinstance(raw.get('meetings'), list) else []
    return {'id': raw.get('id') if FOLDER_ID.fullmatch(str(raw.get('id'))) else None,
            'name': raw.get('name') if _text(raw.get('name'), MAX_FOLDER_NAME) else '',
            'owner': raw.get('owner') if isinstance(raw.get('owner'), str) else '',
            'members': {email: role for email, role in members.items() if isinstance(email, str) and role in ROLES},
            'meetings': list(dict.fromkeys(m for m in meetings if MEETING_ID.fullmatch(str(m))))[:MAX_FOLDER_MEETINGS],
            'deleted': raw.get('deleted') is True}


def load_folder(store, folder_id):
    if not FOLDER_ID.fullmatch(str(folder_id)):
        return None
    folder = normalize_folder(store.load(folder_key(folder_id))[0])
    return folder if folder['id'] and not folder['deleted'] else None


def create_shared_folder(store, email, name):
    name = _folder_name(name)
    folder_id = uuid.uuid4().hex
    _update(store, folder_key(folder_id), normalize_folder,
            lambda state: state.update(id=folder_id, name=name, owner=email, members={email: 'editor'}, meetings=[], deleted=False))
    join_shared_folder(store, email, folder_id)
    return folder_id


def join_shared_folder(store, email, folder_id):
    def change(state):
        if folder_id not in state['shared_folders']:
            if len(state['shared_folders']) >= MAX_SHARED_FOLDERS:
                raise WorkspaceError('Too many shared folders')
            state['shared_folders'].append(folder_id)
    return _update(store, user_key(email), normalize_user, change)


def leave_shared_folder(store, email, folder_id):
    return _update(store, user_key(email), normalize_user,
                   lambda state: state.update(shared_folders=[f for f in state['shared_folders'] if f != folder_id]))


def change_folder(store, folder_id, change):
    def guarded(state):
        if not state['id'] or state['deleted']:
            raise WorkspaceError('Folder not found')
        change(state)
    # Always the folder as saved, whatever the change function returned.
    return _update(store, folder_key(folder_id), normalize_folder, guarded)


def grant_folder_access(store, meeting_id, folder_id, members):
    """Record on the note which colleagues reach it through this folder."""
    def change(state):
        for email, grants in list(state['folder_members'].items()):
            grants.pop(folder_id, None)
            if not grants:
                del state['folder_members'][email]
        for email, role in members.items():
            state['folder_members'].setdefault(email, {})[folder_id] = role
    return _update(store, extra_key(meeting_id), normalize_extra, change)


# ---- Saved prompts: questions people reuse, private or shared with the team ----

TEAM_PROMPTS = 'notes-prompts/team'


def normalize_team_prompts(raw):
    raw = raw if isinstance(raw, dict) else {}
    prompts = raw.get('prompts') if isinstance(raw.get('prompts'), list) else []
    return {'prompts': [p for p in prompts if isinstance(p, dict) and FOLDER_ID.fullmatch(str(p.get('id')))
                        and _text(p.get('title'), MAX_PROMPT_TITLE) and _text(p.get('text'), MAX_PROMPT_CHARS)
                        and p.get('scope') in PROMPT_SCOPES and isinstance(p.get('by'), str)][:200]}


def _prompt(title, text, scope):
    title = ' '.join(title.split()) if isinstance(title, str) else ''
    text = text.strip() if isinstance(text, str) else ''
    if not title or len(title) > MAX_PROMPT_TITLE or not text or len(text) > MAX_PROMPT_CHARS or scope not in PROMPT_SCOPES:
        raise WorkspaceError('Give the prompt a short name, its text, and where it applies')
    return {'id': uuid.uuid4().hex, 'title': title, 'text': text, 'scope': scope}


def save_prompt(store, email, title, text, scope, team=False):
    prompt = _prompt(title, text, scope)
    if team:
        def change(state):
            if len(state['prompts']) >= 200:
                raise WorkspaceError('The team prompt list is full')
            state['prompts'].append({**prompt, 'by': email})
        _update(store, TEAM_PROMPTS, normalize_team_prompts, change)
    else:
        def change(state):
            if len(state['prompts']) >= MAX_PROMPTS:
                raise WorkspaceError('You have saved the maximum number of prompts')
            state['prompts'].append(prompt)
        _update(store, user_key(email), normalize_user, change)
    return prompt


def delete_prompt(store, email, prompt_id):
    _update(store, user_key(email), normalize_user, lambda state: state.update(prompts=[p for p in state['prompts'] if p['id'] != prompt_id]))
    def change(state):
        # Anyone may remove their own team prompt; nobody removes someone else's.
        state['prompts'] = [p for p in state['prompts'] if not (p['id'] == prompt_id and p['by'] == email)]
    _update(store, TEAM_PROMPTS, normalize_team_prompts, change)


def list_prompts(store, email):
    mine = load_user(store, email)['prompts']
    team = normalize_team_prompts(store.load(TEAM_PROMPTS)[0])['prompts']
    return {'mine': mine, 'team': [{**p, 'mine': p['by'] == email} for p in team]}


# ---- Personal access tokens for MCP clients (Claude, ChatGPT and others) ----

def token_key(token):
    return 'notes-mcp/' + hashlib.sha256(token.encode()).hexdigest()


def create_token(store, email, label, now):
    import secrets
    label = ' '.join(label.split()) if isinstance(label, str) else ''
    if not label or len(label) > 60:
        raise WorkspaceError('Name the connection, for example "Claude on my laptop"')
    token = 'reel_mcp_' + secrets.token_urlsafe(32)
    token_id = hashlib.sha256(token.encode()).hexdigest()[:16]
    def change(state):
        if len(state['mcp_tokens']) >= MAX_TOKENS:
            raise WorkspaceError('Revoke an old connection first')
        state['mcp_tokens'].append({'id': token_id, 'label': label, 'created': now})
    _update(store, user_key(email), normalize_user, change)
    _update(store, token_key(token), lambda raw: raw if isinstance(raw, dict) else {},
            lambda state: state.update(email=email, id=token_id, created=now))
    return token, token_id


def revoke_token(store, email, token_id):
    _update(store, user_key(email), normalize_user,
            lambda state: state.update(mcp_tokens=[t for t in state['mcp_tokens'] if t['id'] != token_id]))


def token_owner(store, token):
    """The email behind a token, only while the token is still listed as active for that person."""
    if not isinstance(token, str) or not token.startswith('reel_mcp_') or len(token) > 100:
        return None
    record, _ = store.load(token_key(token))
    if not isinstance(record, dict) or not isinstance(record.get('email'), str) or not is_internal_email(record['email']):
        return None
    active = {t['id'] for t in load_user(store, record['email'])['mcp_tokens']}
    return record['email'] if record.get('id') in active else None
