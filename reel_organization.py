"""Organization policy supplied by the deployment, never by a caller's email."""
import os
import re
from urllib.parse import urlsplit, urlunsplit


def public_account_access():
    return os.getenv("REEL_ACCOUNT_ACCESS") == "public"


def public_google_account(claims):
    if not isinstance(claims, dict) or claims.get("email_verified") is not True:
        return False
    email, uid = claims.get("email"), claims.get("sub")
    firebase = claims.get("firebase")
    identities = firebase.get("identities") if isinstance(firebase, dict) else None
    subjects = identities.get("google.com") if isinstance(identities, dict) else None
    return bool(
        isinstance(email, str) and len(email) <= 320 and re.fullmatch(r"[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+", email)
        and isinstance(uid, str) and 0 < len(uid) <= 128
        and isinstance(firebase, dict) and firebase.get("sign_in_provider") == "google.com"
        and isinstance(subjects, list) and len(subjects) == 1
        and isinstance(subjects[0], str) and 0 < len(subjects[0]) <= 255
    )


def organization_domain():
    domain = os.getenv("REEL_ORGANIZATION_DOMAIN", "").strip().lower()
    labels = domain.split(".")
    if (len(domain) > 253 or len(labels) < 2
            or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                   for label in labels)):
        return ""
    return domain


def is_internal_email(address):
    domain = organization_domain()
    return bool(domain and isinstance(address, str)
                and re.fullmatch(r"[^@\s<>]+@" + re.escape(domain), address.lower()))


def explicit_meeting_owner(address):
    """Retain explicitly configured account access for restricted deployments."""
    if not isinstance(address, str):
        return False
    allowed = {value.strip().lower() for value in os.getenv("REEL_ALLOWED_EMAILS", "").split(",") if value.strip()}
    return address.lower() in allowed


def meeting_domain_enabled():
    domain = organization_domain()
    return bool(domain and os.getenv("REEL_MEETING_ALLOWED_DOMAIN", "").strip().lower() == domain)


def meeting_owner_allowed(address):
    """Use a deployment's domain opt-in or its explicit account list."""
    return explicit_meeting_owner(address) or (meeting_domain_enabled() and is_internal_email(address))


def firebase_project():
    project = os.getenv("REEL_FIREBASE_PROJECT", "").strip()
    return project if re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project) else ""


def _safe_url(value, *, origin_only):
    if not value or any(ord(char) < 32 or char.isspace() for char in value):
        return ""
    try:
        url = urlsplit(value)
        local = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if (not url.hostname or "*" in url.hostname or url.username or url.password or url.query or url.fragment
                or url.scheme not in ({"https", "http"} if local else {"https"})
                or (origin_only and url.path not in ("", "/"))):
            return ""
        url.port  # Reject malformed ports before using the value in a URL or header.
        return urlunsplit((url.scheme, url.netloc.lower(), url.path.rstrip("/"), "", ""))
    except ValueError:
        return ""


def trusted_origins():
    return frozenset(origin for value in os.getenv("REEL_ALLOWED_ORIGINS", "").split(",")
                     if (origin := _safe_url(value.strip(), origin_only=True)))


def notes_base_url():
    return _safe_url(os.getenv("REEL_NOTES_BASE_URL", "").strip(), origin_only=False)
