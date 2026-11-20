"""Guest UI adapters. Selector evidence: Vexa f1a62fbb (see README).

No sign-in, CAPTCHA solving, stealth plugins, or anti-bot evasion.
A lobby leave button alone is deliberately NOT Meet admission evidence.
"""
import json
import os
import re
import time
from urllib.parse import urlsplit
from policy import admission_decision
try:
    from playwright.async_api import Error as PlaywrightError, TimeoutError as PlaywrightTimeoutError
except ImportError:  # Pure unit tests do not install Chromium/Playwright.
    class PlaywrightError(Exception):
        pass

    PlaywrightTimeoutError = TimeoutError

DENIED = re.compile(r"denied your request|request to join was denied|weren[’']t allowed to join|not allowed to join|you were denied|you can[’']t join this video call|access denied|entry denied|unable to join|meeting not found|invalid meeting|meeting link is invalid|meeting link expired", re.I)
BLOCKED = re.compile(r"automated bots aren[’']t allowed|must use zoom rtms|detected you may be a bot|sign in to join|sign in to (?:this|the) meeting|you need to sign in|verify you are human|verify that you|complete the captcha", re.I)
WAITING = {
    'meet': re.compile(r"asking to be let in|join the call when someone lets you|waiting for the host to let you|please wait until a meeting host", re.I),
    'teams': re.compile(r"someone will let you in|you[’']re in the lobby|waiting for someone to let you|waiting to be admitted|wait for someone to admit", re.I),
    'zoom': re.compile(r"please wait.*host|waiting for the host to start|waiting room|we[’']ve let them know", re.I),
}
ENDED = re.compile(r"you[’']ve been removed|you have been removed|removed from (?:the |this )?meeting|meeting (?:has )?ended|call ended|you left the meeting|ended by (?:the )?host", re.I)

CONTROL_TEXT = """(body, captionRoots) => {
    if (body.closest(captionRoots)) return '';
    if (!body.querySelector(captionRoots)) return body.innerText;

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                return node.matches(captionRoots) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const range = document.createRange();
    const rendered = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent.trim();
        if (!value || getComputedStyle(node.parentElement).visibility !== 'visible') continue;
        range.selectNodeContents(node);
        if (range.getClientRects().length) rendered.push(value);
    }
    return rendered.join(' ');
}"""


async def visible(page, selectors):
    for frame in page.frames:
        for selector in selectors:
            for element in await frame.locator(selector).all():
                if await element.is_visible():
                    return True
    return False


async def click_first(page, selectors):
    for frame in page.frames:
        for selector in selectors:
            for element in await frame.locator(selector).all():
                if await element.is_visible() and await element.is_enabled():
                    await element.click(timeout=2000)
                    return True
    return False


async def click_named_button(page, names):
    for frame in page.frames:
        for name in names:
            choices = [(frame.get_by_role('button', name=name, exact=True), False),
                       (frame.get_by_role('button').filter(has=frame.get_by_text(name, exact=True)), True)]
            for buttons, needs_visible_label in choices:
                matches = []
                for element in await buttons.all():
                    if not await element.is_visible() or not await element.is_enabled():
                        continue
                    if needs_visible_label and not any([
                            await label.is_visible() for label in await element.get_by_text(name, exact=True).all()]):
                        continue
                    matches.append(element)
                if len(matches) > 1:
                    return False
                if matches:
                    await matches[0].click(timeout=2000)
                    return True
    return False


async def fill_first(page, selectors, value):
    for frame in page.frames:
        for selector in selectors:
            for element in await frame.locator(selector).all():
                if await element.is_visible() and await element.is_editable():
                    await element.fill(value, timeout=2000)
                    return True
    return False


def caption_roots():
    from browser_captions import SELECTORS
    return ','.join(config['root'] for config in SELECTORS.values())


async def body_text(page, *, ignore_captions=False):
    texts = []
    for frame in page.frames:
        try:
            body = frame.locator('body')
            if ignore_captions:
                texts.append(await body.evaluate(CONTROL_TEXT, caption_roots(), timeout=1500))
            else:
                texts.append(await body.inner_text(timeout=1500))
        except Exception:
            pass
    return '\n'.join(texts)


async def notes_consent_gate(page):
    for frame in page.frames:
        for dialog in await frame.locator('[role="dialog"], [role="alertdialog"]').all():
            if await dialog.is_visible():
                text = await dialog.evaluate(CONTROL_TEXT, caption_roots(), timeout=1500)
                if re.search(r'take notes for me|taking notes', ' '.join(text.split()), re.I):
                    return True
    return False


async def observe(page, provider):
    text = await body_text(page, ignore_captions=True)
    host = urlsplit(page.url).hostname or ''
    blocked = bool(BLOCKED.search(text)) or host in {'accounts.google.com', 'login.microsoftonline.com', 'login.live.com'}
    captcha_selectors = ['iframe[src*="recaptcha"][title*="challenge" i]',
                         'iframe[title*="recaptcha" i][title*="challenge" i]',
                         'iframe[src*="recaptcha"][src*="/bframe"]', '#recaptcha-anchor',
                         'iframe[src*="hcaptcha"]', '#captcha']
    # Meet displays a passive reCAPTCHA branding iframe on normal prejoin pages.
    # A visible checkbox or challenge still requires human verification.
    if provider != 'meet':
        captcha_selectors.append('iframe[title*="reCAPTCHA"]')
    blocked = blocked or await visible(page, captcha_selectors)
    gate = await notes_consent_gate(page)
    selectors = {
        'meet': ['[data-participant-id]', '[data-self-name]', 'button[aria-label*="Present now"]', 'button[aria-label*="Share screen"]'],
        'teams': ['button#hangup-button', 'button[data-tid="hangup-main-btn"]'],
        'zoom': ['.meeting-app button[aria-label="Leave"]', '#wc-container button[aria-label="Leave"]'],
    }
    return dict(denied=bool(DENIED.search(text)), blocked=blocked, consent_gate=gate,
                waiting=bool(WAITING[provider].search(text)), in_call=await visible(page, selectors[provider]))


async def prepare_and_join(page, p, callback, stopped, diagnostic=None, *, authenticated_google=False):
    provider = p['provider']
    await callback('requesting_entry')
    started = time.monotonic()
    try:
        # A committed document is enough to inspect the guest UI. Long-loading
        # provider assets must not suppress evidence from the live partial page.
        await page.goto(p['meeting_url'], wait_until='commit',
                        timeout=min(15000, p['admission_timeout_seconds'] * 1000))
    except PlaywrightTimeoutError:
        # Inspect this same page; never navigate/rejoin again on a timeout.
        pass
    if diagnostic:
        await diagnostic(page, 'navigation')
    last_diagnostic = time.monotonic()
    clicked_join = False
    last_status = 'requesting_entry'

    async def entry_observation():
        while not stopped():
            try:
                return await observe(page, provider)
            except PlaywrightError as error:
                # Teams may replace the guest document while we inspect it.
                # Retry only reads on this page, never navigation or join actions.
                if provider != 'teams' or not any(message in str(error).lower() for message in (
                    'execution context was destroyed',
                    'cannot find context with specified id',
                    'frame was detached',
                    'execution context is not available in detached frame',
                )):
                    raise
                remaining = started + p['admission_timeout_seconds'] - time.monotonic()
                if remaining <= 0:
                    return {}
                if os.environ.get('BOT_DIAGNOSTICS') == '1':
                    print(json.dumps({'status': 'join_observation_retry',
                                      'detail': 'navigation_in_progress'}), flush=True)
                await page.wait_for_timeout(min(1000, remaining * 1000))
                if time.monotonic() - started >= p['admission_timeout_seconds']:
                    return {}
        raise RuntimeError('execution_stopped')

    while not stopped():
        if diagnostic and time.monotonic() - last_diagnostic >= 15:
            await diagnostic(page, 'waiting')
            last_diagnostic = time.monotonic()
        if provider == 'meet' and (urlsplit(page.url).hostname or '').lower() == 'workspace.google.com':
            raise RuntimeError('join_page_unavailable')
        state = await entry_observation()
        verdict = admission_decision(**state, elapsed=time.monotonic()-started, timeout=p['admission_timeout_seconds'])
        if verdict == 'joined':
            # Two successive positive observations reduce transient DOM false admission.
            await page.wait_for_timeout(1000)
            confirmation = await entry_observation()
            verdict = admission_decision(**confirmation, elapsed=time.monotonic()-started, timeout=p['admission_timeout_seconds'])
            if verdict == 'joined':
                await callback('joined')
                return
        if verdict in {'denied', 'human_action_required', 'admission_timeout'}:
            if verdict == 'admission_timeout' and last_status != 'awaiting_admission':
                verdict = 'admission_unconfirmed' if clicked_join else 'join_not_available'
            raise RuntimeError(verdict)
        if verdict == 'awaiting_admission':
            if last_status != verdict:
                await callback(verdict)
                last_status = verdict
        elif not clicked_join:
            if provider == 'teams':
                await click_first(page, ['button:has-text("Continue on this browser")', 'button:has-text("Continue in this browser")', 'button:has-text("Continue without audio or video")', 'a:has-text("Continue on this browser")'])
                await fill_first(page, ['input[placeholder*="name" i]', 'input[data-tid="prejoin-display-name"]'], p['display_name'])
                await click_first(page, ['button[aria-label*="Turn off camera"]', 'button[aria-label*="Turn camera off"]', 'button[aria-label*="Mute microphone"]'])
                clicked_join = await click_first(page, ['button:has-text("Join now")', 'button[data-tid="prejoin-join-button"]'])
            elif provider == 'meet':
                if not authenticated_google:
                    await fill_first(page, ['input[aria-label="Your name"]', 'input[placeholder*="name" i]', 'input[jsname][type="text"]'], p['display_name'])
                await click_first(page, ['button[aria-label*="Turn off microphone"]'])
                await click_first(page, ['button[aria-label*="Turn off camera"]'])
                # Meet's warning icons can also become part of the accessible name.
                clicked_join = await click_named_button(page, ['Ask to join', 'Join now'])
            else:
                await click_first(page, ['button:has-text("Continue without microphone and camera")'])
                await fill_first(page, ['#input-for-name', '#inputname', 'input[placeholder="Your Name" i]'], p['display_name'])
                await click_first(page, ['#preview-audio-control-button[aria-label="Mute"]'])
                await click_first(page, ['#preview-video-control-button[aria-label="Stop Video"]'])
                clicked_join = await click_first(page, ['button.preview-join-button', '#joinBtn'])
        await page.wait_for_timeout(1000)
    raise RuntimeError('execution_stopped')


async def monitor(page, provider, duration, stopped, ffmpeg, check_media=None):
    started = time.monotonic()
    missing_since = None
    while not stopped() and time.monotonic() - started < duration:
        if ffmpeg.poll() is not None:
            raise RuntimeError('recorder_exited')
        if check_media is not None:
            check_media()
        text = await body_text(page, ignore_captions=True)
        if ENDED.search(text):
            return 'meeting_ended'
        state = await observe(page, provider)
        if state['blocked'] or state['denied'] or state['consent_gate']:
            raise RuntimeError('meeting_access_lost')
        if state['in_call'] and not state['waiting']:
            missing_since = None
        else:
            missing_since = missing_since or time.monotonic()
            if time.monotonic() - missing_since > 30:
                raise RuntimeError('meeting_connection_lost')
        if provider == 'zoom':
            # Join only the receiving browser audio; microphone stays muted.
            await click_first(page, ['button:has-text("Join Audio by Computer")', 'button:has-text("Join Audio by Computer Audio")'])
        await page.wait_for_timeout(2000)
    return 'execution_stopped' if stopped() else 'duration_limit'
