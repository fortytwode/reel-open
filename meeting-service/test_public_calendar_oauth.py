import copy
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.fernet import Fernet

from calendar_meetings import CalendarProviderError, CalendarUnavailable
from public_calendar_oauth import CALENDAR_SCOPES, TOKEN_URL, CalendarOAuthError, PublicCalendarOAuth


ORIGIN = "https://reel.example.com"
REDIRECT = "https://meetings.example.com/calendar/oauth/callback"
REFRESH = "synthetic-refresh"
CODE = "synthetic-code"
CLAIMS = {"sub": "firebase-user", "email": "owner@example.net", "email_verified": True,
          "firebase": {"sign_in_provider": "google.com", "identities": {"google.com": ["123456789"]}}}


class MemoryStore:
    def __init__(self):
        self.rows = {}

    def load(self, key):
        return copy.deepcopy(self.rows.get(key, (None, 0)))

    def cas(self, key, row, expected):
        _, generation = self.load(key)
        if generation != expected:
            raise ValueError("generation changed")
        self.rows[key] = (copy.deepcopy(row), generation + 1)


class TokenResponse:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self.data = data

    def json(self):
        return self.data


@pytest.fixture
def workflow(monkeypatch):
    values = {"REEL_ACCOUNT_ACCESS": "public", "MEETING_SERVICE_URL": "https://meetings.example.com",
              "REEL_ALLOWED_ORIGINS": ORIGIN, "REEL_CALENDAR_OAUTH_CLIENT_ID": "123-test.apps.googleusercontent.com",
              "REEL_CALENDAR_OAUTH_CLIENT_SECRET": "test-secret",
              "REEL_CALENDAR_OAUTH_REDIRECT_URI": REDIRECT,
              "REEL_CALENDAR_OAUTH_ENCRYPTION_KEY": Fernet.generate_key().decode()}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    provider = {
        "requests": [], "time": 100.0,
        "identity": {"sub": "123456789", "email": "OWNER@example.net", "email_verified": True},
        "tokens": {"scope": " ".join(CALENDAR_SCOPES), "refresh_token": REFRESH, "id_token": "synthetic-id",
                   "access_token": "synthetic-access", "token_type": "Bearer"},
    }

    def post(url, *, data, timeout, allow_redirects):
        assert url == TOKEN_URL and timeout <= 10 and allow_redirects is False
        provider["requests"].append(data)
        if hook := provider.get("during_post"):
            hook()
        if provider.get("invalid_grant"):
            return TokenResponse(400, {"error": "invalid_grant", "error_description": "private-details"})
        return TokenResponse(200, provider["tokens"])

    def verify(token, audience):
        assert token == "synthetic-id" and audience == values["REEL_CALENDAR_OAUTH_CLIENT_ID"]
        return provider["identity"]

    return PublicCalendarOAuth(MemoryStore(), clock=lambda: provider["time"], post=post, verify_id_token=verify), provider


def begin(oauth, provider):
    url = urlsplit(oauth.begin(CLAIMS, ORIGIN))
    assert url.hostname == "accounts.google.com"
    query = {key: val[0] for key, val in parse_qs(url.query).items()}
    provider["identity"]["nonce"] = query["nonce"]
    return query


def test_binds_and_encrypts_offline_grant_for_only_the_verified_account(workflow):
    oauth, provider = workflow
    request = begin(oauth, provider)
    assert request["redirect_uri"] == REDIRECT
    assert request["access_type"] == "offline"
    assert request["code_challenge_method"] == "S256"
    assert request["response_mode"] == "form_post"
    assert set(request["scope"].split()) == CALENDAR_SCOPES | {"openid", "email"}
    assert not oauth.connected(CLAIMS)
    assert oauth.complete(request["state"], CODE, None) == (ORIGIN, True)
    assert oauth.connected(CLAIMS)
    assert REFRESH not in repr(oauth.store.rows)
    assert "synthetic-access" not in repr(oauth.store.rows)
    assert CODE not in repr(oauth.store.rows)
    assert len(provider["requests"][0]["code_verifier"]) == 43
    with pytest.raises(CalendarUnavailable, match="Connect"):
        oauth.factory(CLAIMS["email"], [], "other-uid")
    client = oauth.factory(CLAIMS["email"], ["primary"], CLAIMS["sub"])
    assert client.session.headers["Authorization"] == "Bearer synthetic-access"
    assert client.calendar_ids == {"primary"}
    assert provider["requests"][1]["grant_type"] == "refresh_token"
    assert provider["requests"][1]["refresh_token"] == REFRESH
    with pytest.raises(CalendarOAuthError, match="expired or was already used"):
        oauth.complete(request["state"], CODE, None)


@pytest.mark.parametrize(("field", "value"), [
    ("sub", "987654321"), ("email", "wrong@example.net"), ("email_verified", False), ("nonce", "tampered"),
])
def test_rejects_different_or_unverified_google_identity(workflow, field, value):
    oauth, provider = workflow
    request = begin(oauth, provider)
    provider["identity"][field] = value
    assert oauth.complete(request["state"], CODE, None) == (ORIGIN, False)
    assert not oauth.connected(CLAIMS)


def test_reuses_neither_expired_state_nor_denied_state(workflow):
    oauth, provider = workflow
    first = begin(oauth, provider)
    assert oauth.complete(first["state"], None, "access_denied") == (ORIGIN, False)
    with pytest.raises(CalendarOAuthError):
        oauth.complete(first["state"], CODE, None)
    second = begin(oauth, provider)
    provider["time"] += 601
    with pytest.raises(CalendarOAuthError):
        oauth.complete(second["state"], CODE, None)
    assert not provider["requests"]


def test_denies_unsafe_return_origin_missing_scopes_or_offline_grant(workflow):
    oauth, provider = workflow
    for origin in (ORIGIN + ".example.net", ORIGIN + "/redirect", ORIGIN + "?next=", "http://reel.example.com"):
        with pytest.raises(CalendarOAuthError, match="origin"):
            oauth.begin(CLAIMS, origin)
    request = begin(oauth, provider)
    provider["tokens"]["scope"] = next(iter(CALENDAR_SCOPES))
    assert oauth.complete(request["state"], CODE, None) == (ORIGIN, False)
    provider["tokens"]["scope"] = " ".join(CALENDAR_SCOPES)
    provider["tokens"].pop("refresh_token")
    request = begin(oauth, provider)
    assert oauth.complete(request["state"], CODE, None) == (ORIGIN, False)
    assert not oauth.connected(CLAIMS)


def test_disconnect_fences_callback_and_refresh_in_flight(workflow):
    oauth, provider = workflow
    pending = begin(oauth, provider)
    provider["during_post"] = lambda: oauth.disconnect(CLAIMS)
    assert oauth.complete(pending["state"], CODE, None) == (ORIGIN, False)
    assert not oauth.connected(CLAIMS)
    provider.pop("during_post")
    pending = begin(oauth, provider)
    assert oauth.complete(pending["state"], CODE, None) == (ORIGIN, True)
    provider["during_post"] = lambda: oauth.disconnect(CLAIMS)
    with pytest.raises(CalendarUnavailable, match="authorization changed"):
        oauth.factory(CLAIMS["email"], [], CLAIMS["sub"])
    assert not oauth.connected(CLAIMS)


def test_revoked_google_grant_requires_a_fresh_authorization(workflow):
    oauth, provider = workflow
    pending = begin(oauth, provider)
    assert oauth.complete(pending["state"], CODE, None) == (ORIGIN, True)
    provider["invalid_grant"] = True
    with pytest.raises(CalendarUnavailable, match="Reconnect"):
        oauth.factory(CLAIMS["email"], [], CLAIMS["sub"])
    assert not oauth.connected(CLAIMS)


def test_config_fails_closed_for_other_callback_or_organization_mode(workflow, monkeypatch):
    assert PublicCalendarOAuth.configured()
    monkeypatch.setenv("REEL_CALENDAR_OAUTH_REDIRECT_URI", REDIRECT + "?unexpected=1")
    assert not PublicCalendarOAuth.configured()
    with pytest.raises(CalendarProviderError, match="not configured"):
        PublicCalendarOAuth(MemoryStore())
    monkeypatch.setenv("REEL_CALENDAR_OAUTH_REDIRECT_URI", REDIRECT)
    monkeypatch.setenv("REEL_ACCOUNT_ACCESS", "organization")
    assert not PublicCalendarOAuth.configured()
