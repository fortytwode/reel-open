"""Controls and caption DOM observed in the providers' in-call browser UI."""
from urllib.parse import urlsplit
from providers import PlaywrightTimeoutError

MEET = {
    'root': 'div[role="region"][aria-label="Captions"]',
    'row': 'div.nMcdL',
    'name': 'span.NWpY1d',
    'text': 'div.ygicle',
}

TEAMS = {
    'root': 'div[data-tid="closed-caption-renderer-wrapper"][aria-label="Live Captions"]',
    'row': ('[data-tid="closed-caption-v2-virtual-list-content"] [role="log"] '
            '.fui-ChatMessageCompact span[data-tid="closed-caption-text"]'),
    'group': '.fui-ChatMessageCompact',
    'name': 'span[data-tid="author"]',
}

SELECTORS = {'meet': MEET, 'teams': TEAMS}
HOSTS = {'meet': {'meet.google.com'}, 'teams': {'teams.live.com', 'teams.microsoft.com'}}


async def visible_element(locator):
    matches = [item for item in await locator.all() if await item.is_visible()]
    return matches[0] if len(matches) == 1 else None


async def click(locator):
    element = await visible_element(locator)
    if element is None or not await element.is_enabled():
        return False
    try:
        await element.click(timeout=750)
        return True
    except PlaywrightTimeoutError:
        return False


async def open_menu_then_click(menu, item):
    if await click(item):
        return True
    if not await click(menu):
        return False
    try:
        await item.filter(visible=True).wait_for(state='visible', timeout=1200)
    except PlaywrightTimeoutError:
        return False
    return await click(item)


async def meet_controls(frame):
    def button(name):
        return frame.get_by_role('button', name=name, exact=True)

    # Meet's ordinary media tips sometimes cover the caption button.
    # Match only the expected dialog notice and its own dismissal control.
    for notice, dismiss in [('Microphone not found', 'Close'),
                            ('Others may see your video differently', 'Got it')]:
        for role in ('dialog', 'alertdialog'):
            dialogs = frame.get_by_role(role).filter(has=frame.get_by_text(notice, exact=True))
            dialog = await visible_element(dialogs)
            if dialog is not None:
                await click(dialog.get_by_role('button', name=dismiss, exact=True))
    if await visible_element(button('Turn off live captions')) is not None:
        return True
    return await open_menu_then_click(button('Captions and translation'), button('Turn on captions'))


async def teams_controls(frame):
    if await visible_element(frame.get_by_role('button', name='Hide live captions', exact=True)) is not None:
        return True
    return await open_menu_then_click(frame.get_by_role('button', name='More', exact=True),
                                      frame.get_by_role('menuitem', name='Captions', exact=True))


async def caption_frame(page, provider, *, enable):
    config = SELECTORS.get(provider)
    if config is None:
        return None
    frames = [frame for frame in page.frames if (url := urlsplit(frame.url)).scheme == 'https'
              and url.hostname in HOSTS[provider]]
    for frame in frames:
        if await visible_element(frame.locator(config['root'])) is not None:
            return frame
    if enable:
        controls = meet_controls if provider == 'meet' else teams_controls
        for frame in frames:
            if await controls(frame):
                return frame
    return None


INSTALL = r"""
({selector, elapsed, skipExisting}) => {
    if (!document.body) return false;
    if (globalThis.__reelCaptionObserver) return false;
    const pending = new Map();
    const active = new Map();
    const clock = performance.now();
    const MAX_ROWS = 128;
    const MAX_TEXT = 12000;
    const MAX_PENDING_CHARS = 65536;
    let root = null;
    let nextId = 0;
    let chars = 0;
    let overflow = false;
    let ignored = false;

    function rows() {
        const matches = root.querySelectorAll(selector.row);
        if (matches.length > MAX_ROWS) overflow = true;
        return Array.prototype.slice.call(matches, -MAX_ROWS);
    }

    function value(item) {
        return item ? item.textContent.trim().replace(/\s+/gu, ' ') : '';
    }

    function revision(old, raw, observed) {
        // Preserve the completed window when a row recycles. Strip a known
        // repeated prefix only when it exactly matches the old window's tail.
        const before = old.raw.toLowerCase().split(' ');
        const after = raw.toLowerCase().split(' ');
        if (before[0] !== after[0]) {
            for (let count = Math.min(before.length - 1, after.length, 64); count >= 2; count--) {
                if (before.slice(-count).every((word, index) => word === after[index])) {
                    return {reuse: true, prefix: raw.split(' ').slice(0, count).join(' ')};
                }
            }
            if (before.length >= 3 && (/[.!?…]$/.test(old.raw) || observed - old.end > 3)) {
                const words = new Set(before);
                if (!after.some(word => words.has(word))) return {reuse: true, prefix: ''};
            }
        }
        const prefix = raw.startsWith(old.prefix + ' ') || raw === old.prefix ? old.prefix : '';
        return {reuse: false, prefix};
    }

    function scan(initial) {
        const observed = elapsed + (performance.now() - clock) / 1000;
        const visible = new Set(rows());
        for (const row of active.keys()) {
            if (!visible.has(row)) active.delete(row);
        }
        for (const row of visible) {
            const group = selector.group ? row.closest(selector.group) : row;
            const authors = group.querySelectorAll(selector.name);
            const name = value(authors.length === 1 ? authors[0] : null);
            const raw = value(selector.text ? row.querySelector(selector.text) : row);
            if (!raw) {
                active.delete(row);
                continue;
            }
            const old = active.get(row);
            if (old && old.name === name && old.raw === raw) continue;
            if (old && old.name !== name && old.raw === raw) {
                ignored = true;
                continue;
            }
            if (!name || name.length > 240 || raw.length > MAX_TEXT) {
                ignored = true;
                continue;
            }
            const sameName = old && old.name === name;
            const {reuse, prefix} = sameName ? revision(old, raw, observed) : {reuse: true, prefix: ''};
            const text = raw.slice(prefix.length).trimStart();
            const same = sameName && !reuse;
            const entry = {
                id: same ? old.id : ++nextId,
                start: same && old.text ? old.start : observed,
                end: observed,
                name,
                text,
                raw,
                prefix,
                skip: initial && skipExisting || Boolean(same && old.skip),
            };
            active.set(row, entry);
            if (entry.skip || !text) continue;
            const previous = pending.get(entry.id);
            const nextChars = chars + name.length + text.length
                - (previous ? previous.name.length + previous.text.length : 0);
            if (nextChars > MAX_PENDING_CHARS || (!previous && pending.size >= MAX_ROWS)) {
                overflow = true;
                continue;
            }
            chars = nextChars;
            pending.set(entry.id, {id: entry.id, start: entry.start, end: entry.end, name, text});
        }
    }

    function process(records) {
        if (!root) {
            attach();
            return;
        }
        for (const record of records) {
            for (const removed of record.removedNodes) {
                if (removed.nodeType !== Node.ELEMENT_NODE) continue;
                for (const row of active.keys()) {
                    if (removed.contains(row)) active.delete(row);
                }
            }
        }
        scan(false);
    }

    const observer = new MutationObserver(process);
    const mutations = {subtree: true, childList: true, characterData: true};

    function attach() {
        const candidates = Array.from(document.querySelectorAll(selector.root))
            .filter(item => item.getClientRects().length && getComputedStyle(item).visibility === 'visible');
        if (candidates.length !== 1) return;
        root = candidates[0];
        observer.disconnect();
        observer.observe(root, mutations);
        scan(true);
    }

    attach();
    if (!root) observer.observe(document.body, {subtree: true, childList: true});
    globalThis.__reelCaptionObserver = (stop) => {
        const records = observer.takeRecords();
        if (records.length) process(records);
        if (!root) attach();
        const result = {alive: !root || root.isConnected, rows: Array.from(pending.values()), overflow, ignored};
        pending.clear();
        chars = 0;
        overflow = ignored = false;
        if (stop || !result.alive) {
            observer.disconnect();
            delete globalThis.__reelCaptionObserver;
        }
        return result;
    };
    return true;
}
"""

DRAIN = '(stop) => globalThis.__reelCaptionObserver?.(stop) ?? null'
