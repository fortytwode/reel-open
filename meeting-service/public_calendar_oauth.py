"""Per-account, read-only Calendar grants for an isolated public deployment."""

import base64
import hashlib
import json
import os
import re
import secrets
import time
from urllib.parse import urlencode

import requests
from cryptography.fernet import Fernet, InvalidToken
from google.auth.transport.requests import Request
from google.oauth2.id_token import verify_oauth2_token

from calendar_meetings import CalendarMeetingError, CalendarProviderError, CalendarUnavailable, _GoogleCalendar
from reel_organization import _safe_url, public_google_account, trusted_origins


AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CALENDAR_SCOPES = frozenset({
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
})
STATE_LIFETIME = 600
STATE_PATTERN = r"[A-Za-z0-9_-]{43}"


class CalendarOAuthError(CalendarMeetingError):
    """An OAuth error safe to show without exposing provider response data."""


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _email(value):
    if isinstance(value, str) and len(value) <= 320 and re.fullmatch(r"[^@\s<>]+@[^@\s<>]+", value):
        return value.lower()
    return ""


def _binding(claims):
    if not public_google_account(claims):
        raise CalendarOAuthError("Sign in with your verified Google account to connect Calendar")
    return {"email": claims["email"].lower(), "uid": claims["sub"],
            "google_subject": claims["firebase"]["identities"]["google.com"][0]}


def _configuration():
    client_id = os.getenv("REEL_CALENDAR_OAUTH_CLIENT_ID", "")
    secret = os.getenv("REEL_CALENDAR_OAUTH_CLIENT_SECRET", "")
    redirect = os.getenv("REEL_CALENDAR_OAUTH_REDIRECT_URI", "")
    service = _safe_url(os.getenv("MEETING_SERVICE_URL", ""), origin_only=True)
    if (os.getenv("REEL_ACCOUNT_ACCESS") != "public"
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com", client_id)
            or not _is_opaque(secret, 512)
            or not service.startswith("https://")
            or redirect != service + "/calendar/oauth/callback"
            or not any(origin.startswith("https://") for origin in trusted_origins())):
        raise CalendarProviderError("Google Calendar authorization is not configured")
    try:
        seal = Fernet(os.getenv("REEL_CALENDAR_OAUTH_ENCRYPTION_KEY", "").encode("ascii"))
    except (ValueError, UnicodeError):
        raise CalendarProviderError("Google Calendar authorization is not configured") from None
    return client_id, secret, redirect, seal


def _is_opaque(value, maximum=8192):
    return isinstance(value, str) and 0 < len(value) <= maximum and all("!" <= ch <= "~" for ch in value)


def _verify_id_token(token, client_id):
    request = Request()

    def bounded_request(*args, **kwargs):
        return request(*args, **{**kwargs, "timeout": 10})

    return verify_oauth2_token(token, bounded_request, audience=client_id)


class PublicCalendarOAuth:
    def __init__(self, store, *, clock=time.time, post=requests.post, verify_id_token=_verify_id_token):
        self.store = store
        self.clock = clock
        self.post = post
        self.verify_id_token = verify_id_token
        self.client_id, self.secret, self.redirect, self.seal = _configuration()

    @classmethod
    def configured(cls):
        try:
            _configuration()
        except CalendarProviderError:
            return False
        return True

    def _encrypt(self, data):
        return self.seal.encrypt(json.dumps(data, separators=(",", ":")).encode("utf-8")).decode("ascii")

    def _decrypt(self, value):
        try:
            result = json.loads(self.seal.decrypt(value.encode("ascii")))
            return result if isinstance(result, dict) else {}
        except (AttributeError, ValueError, InvalidToken):
            return {}

    @staticmethod
    def _grant_key(email):
        return "calendar-oauth/grants/" + _digest(email)

    def _grant(self, binding):
        key = self._grant_key(binding["email"])
        grant, generation = self.store.load(key)
        if grant is not None and grant.get("binding") != binding:
            raise CalendarOAuthError("Calendar authorization belongs to a different account identity")
        return key, grant or {"binding": binding}, generation

    @staticmethod
    def _valid_origin(origin):
        return isinstance(origin, str) and origin.startswith("https://") and origin in trusted_origins()

    def begin(self, claims, return_origin):
        if not self._valid_origin(return_origin):
            raise CalendarOAuthError("Invalid Calendar authorization origin")
        binding = _binding(claims)
        key, grant, generation = self._grant(binding)
        state, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
        attempt = _digest(state)
        transaction = {"attempt": attempt, "binding": binding, "return_origin": return_origin,
                       "verifier": verifier, "nonce": nonce, "expires_at": self.clock() + STATE_LIFETIME}
        self.store.cas("calendar-oauth/states/" + attempt, {"sealed": self._encrypt(transaction)}, 0)
        self.store.cas(key, {**grant, "pending": attempt}, generation)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
        return AUTH_URL + "?" + urlencode({
            "client_id": self.client_id, "redirect_uri": self.redirect, "response_type": "code",
            "response_mode": "form_post", "scope": "openid email " + " ".join(sorted(CALENDAR_SCOPES)),
            "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256",
            "access_type": "offline", "prompt": "consent", "login_hint": binding["google_subject"],
        })

    def complete(self, state, code, error):
        if not isinstance(state, str) or not re.fullmatch(STATE_PATTERN, state):
            raise CalendarOAuthError("Calendar authorization expired or was already used")
        attempt = _digest(state)
        state_key = "calendar-oauth/states/" + attempt
        row, version = self.store.load(state_key)
        transaction = self._decrypt((row or {}).get("sealed"))
        origin = transaction.get("return_origin")
        if (transaction.get("attempt") != attempt or transaction.get("expires_at", 0) <= self.clock()
                or not self._valid_origin(origin)):
            raise CalendarOAuthError("Calendar authorization expired or was already used")
        try:
            self.store.cas(state_key, {"used": True}, version)
        except Exception:
            raise CalendarOAuthError("Calendar authorization expired or was already used") from None
        if error is not None or not _is_opaque(code):
            return origin, False
        try:
            binding = transaction["binding"]
            key, grant, generation = self._grant(binding)
            if grant.get("pending") != attempt:
                return origin, False
            tokens = self._token({"grant_type": "authorization_code", "code": code,
                                  "code_verifier": transaction["verifier"], "redirect_uri": self.redirect})
            granted = tokens.get("scope")
            if (not isinstance(granted, str) or not CALENDAR_SCOPES <= set(granted.split())
                    or not _is_opaque(tokens.get("refresh_token")) or not _is_opaque(tokens.get("id_token"))):
                return origin, False
            identity = self.verify_id_token(tokens["id_token"], self.client_id)
            if (identity.get("nonce") != transaction["nonce"] or identity.get("sub") != binding["google_subject"]
                    or identity.get("email_verified") is not True or _email(identity.get("email")) != binding["email"]):
                return origin, False
            credential = self._encrypt({"binding": binding, "refresh_token": tokens["refresh_token"]})
            self.store.cas(key, {"binding": binding, "credential": credential}, generation)
        except Exception:
            # Never propagate Google response bodies, authorization codes or verifier errors.
            return origin, False
        return origin, True

    def _credential(self, grant):
        sealed = self._decrypt(grant.get("credential"))
        refresh_token = sealed.get("refresh_token")
        if sealed.get("binding") == grant.get("binding") and _is_opaque(refresh_token):
            return refresh_token
        return None

    def connected(self, claims):
        binding = _binding(claims)
        _, grant, _ = self._grant(binding)
        return bool(self._credential(grant))

    def grant_id(self, owner_email, owner_uid):
        email = _email(owner_email)
        if not email or not owner_uid:
            return None
        grant, _ = self.store.load(self._grant_key(email))
        binding = (grant or {}).get("binding") or {}
        if binding.get("email") == email and binding.get("uid") == owner_uid and self._credential(grant):
            return _digest(grant["credential"])
        return None

    def disconnect(self, claims):
        key, grant, generation = self._grant(_binding(claims))
        # A successful local disconnect discards the grant and fencing marker.
        # Revoking at Google here could also revoke a concurrently authorized grant.
        self.store.cas(key, {"binding": grant["binding"]}, generation)

    def _token(self, data):
        try:
            response = self.post(TOKEN_URL, data={**data, "client_id": self.client_id, "client_secret": self.secret},
                                 timeout=10, allow_redirects=False)
            body = response.json()
            if response.status_code == 400 and isinstance(body, dict) and body.get("error") == "invalid_grant":
                raise CalendarUnavailable("Reconnect your Google Calendar")
            if (response.status_code != 200 or not isinstance(body, dict)
                    or body.get("token_type", "").lower() != "bearer" or not _is_opaque(body.get("access_token"))):
                raise ValueError()
            return body
        except CalendarUnavailable:
            raise
        except Exception:
            raise CalendarProviderError("Google Calendar authorization is temporarily unavailable") from None

    def factory(self, owner_email, calendar_ids, owner_uid):
        email = _email(owner_email)
        if not email or not isinstance(owner_uid, str) or not owner_uid:
            raise CalendarUnavailable("Connect your Google Calendar first")
        key = self._grant_key(email)
        grant, generation = self.store.load(key)
        binding = (grant or {}).get("binding") or {}
        if binding.get("email") != email or binding.get("uid") != owner_uid:
            raise CalendarUnavailable("Connect your Google Calendar first")
        refresh_token = self._credential(grant)
        if not refresh_token:
            raise CalendarUnavailable("Connect your Google Calendar first")
        try:
            token = self._token({"grant_type": "refresh_token", "refresh_token": refresh_token})
        except CalendarUnavailable:
            try:
                self.store.cas(key, {k: v for k, v in grant.items() if k != "credential"}, generation)
            except Exception:
                pass
            raise
        _, current = self.store.load(key)
        if current != generation:
            raise CalendarUnavailable("Calendar authorization changed. Try again.")
        session = requests.Session()
        session.headers["Authorization"] = "Bearer " + token["access_token"]
        return _GoogleCalendar(session, calendar_ids)
