"""Real Chromium regression for Meet's native and ARIA Join controls.

Run with Playwright and its Chromium installed; all requests are locally fulfilled.
"""
import asyncio
from unittest.mock import AsyncMock
from playwright.async_api import async_playwright
import providers


async def captcha_cases(browser):
    badge = '<iframe title="reCAPTCHA" style="width:256px;height:60px" srcdoc="Privacy - Terms"></iframe>'
    cases = [
        ('passive badge', badge, False),
        ('checkbox', '<iframe title="reCAPTCHA" srcdoc="&lt;span id=recaptcha-anchor role=checkbox&gt;I am not a robot&lt;/span&gt;"></iframe>', True),
        ('challenge', '<iframe title="reCAPTCHA challenge" srcdoc="Select the matching images"></iframe>', True),
        ('challenge frame path', '<iframe src="https://www.google.com/recaptcha/enterprise/bframe" srcdoc="Select images"></iframe>', True),
        ('hidden challenge', badge + '<iframe hidden title="reCAPTCHA challenge"></iframe>', False),
        ('verification text', 'Verify you are human', True),
    ]
    for label, html, expected in cases:
        page = await browser.new_page()
        await page.route('**/*', lambda route: route.abort())
        await page.set_content('<body>Ready to join? <button>Join now</button>' + html + '</body>')
        await page.wait_for_load_state('load')
        state = await providers.observe(page, 'meet')
        assert state['blocked'] is expected, label
        await page.close()
        print(f'PASS CAPTCHA: {label}', flush=True)
    page = await browser.new_page()
    await page.set_content(badge)
    assert (await providers.observe(page, 'teams'))['blocked'] is True
    await page.close()
    print('PASS CAPTCHA: other provider detection unchanged', flush=True)


async def icon_cases(browser):
    for label in ('Join now', 'Ask to join'):
        page = await browser.new_page()
        await page.set_content(f'''<button onclick="document.body.dataset.clicked='yes'">
            <i>exclamation</i><span>{label}</span><i>arrow_drop_down</i></button>
            <button>{label} in settings</button>''')
        assert await providers.click_named_button(page, [label])
        assert await page.locator('body').get_attribute('data-clicked') == 'yes'
        await page.close()
        print(f'PASS icon label: {label}', flush=True)
    for html in (
        '<button><i>exclamation</i><span hidden>Join now</span></button>',
        '<button><i>exclamation</i><span>Join now</span></button>' * 2,
    ):
        page = await browser.new_page()
        await page.set_content(html)
        assert not await providers.click_named_button(page, ['Join now'])
        await page.close()
    print('PASS icon label: hidden and ambiguous controls are not clicked', flush=True)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            for tag in ('button', 'div role="button" tabindex="0"'):
                for label in ('Join now', 'Ask to join'):
                    page = await browser.new_page()
                    closing = tag.split()[0]
                    html = f'''<html><body>Ready to join?
                        <button hidden>{label}</button><button disabled>{label}</button>
                        <{tag} onclick="document.querySelector('main').setAttribute('data-participant-id', 'synthetic-peer'); this.remove();">
                            <span>{label}</span></{closing}><main>In the call</main></body></html>'''
                    await page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
                    callback = AsyncMock()
                    await providers.prepare_and_join(page, {
                        'provider': 'meet', 'meeting_url': 'https://meet.google.com/abc-defg-hij',
                        'display_name': 'Synthetic test', 'admission_timeout_seconds': 8,
                    }, callback, lambda: False, authenticated_google=True)
                    assert [call.args[0] for call in callback.await_args_list] == ['requesting_entry', 'joined']
                    assert await page.locator('[data-participant-id="synthetic-peer"]').is_visible()
                    await page.close()
                    print(f'PASS {closing}: {label}', flush=True)
            await captcha_cases(browser)
            await icon_cases(browser)
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
