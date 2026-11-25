import json

import pytest

import calendar_runtime
from calendar_meetings import CalendarMeetingError, CalendarMeetings, org_placeholder_uid, same_account


class Blob:
    def __init__(self, name):
        self.name = name


class Bucket:
    def __init__(self, store):
        self.store = store

    def list_blobs(self, prefix, **_):
        return [Blob(f"p/{k}.json") for k in sorted(self.store.data) if f"p/{k}".startswith(prefix)]


class Store:
    prefix = "p"

    def __init__(self):
        self.data, self.gen = {}, {}
        self.bucket = Bucket(self)

    def load(self, key, **_):
        return (json.loads(json.dumps(self.data[key])), self.gen[key]) if key in self.data else (None, 0)

    def cas(self, key, state, generation, **_):
        if self.gen.get(key, 0) != generation:
            raise RuntimeError("conflict")
        self.data[key] = json.loads(json.dumps(state))
        self.gen[key] = generation + 1
        return self.gen[key]


class Factory:
    def __init__(self, reachable=(), directory=()):
        self.ok, self.directory = set(reachable), set(directory)

    def reachable(self, email):
        return email in self.ok

    def directory_emails(self, domain, admin):
        return self.directory


@pytest.fixture
def org(monkeypatch):
    monkeypatch.setenv("REEL_ORGANIZATION_DOMAIN", "rocketshiphq.com")
    monkeypatch.setenv("MEETING_ORG_AUTO_ENROLL", "rocketshiphq.com")
    monkeypatch.delenv("REEL_PUBLIC_ACCOUNTS", raising=False)


def key(email):
    return "calendar/" + calendar_runtime.digest(email)


def test_everyone_in_the_company_is_enrolled_once_and_opt_outs_are_kept(org, monkeypatch):
    store = Store()
    monkeypatch.setenv("MEETING_DIRECTORY_ADMIN", "shamanth@rocketshiphq.com")
    store.data[key("shamanth@rocketshiphq.com")] = {"config": {"enabled": True, "calendar_ids": ["x"], "owner_uid": "u1"},
        "events": {"e": {"attendees": ["ana@rocketshiphq.com", "client@example.com"]}}}
    store.data[key("bo@rocketshiphq.com")] = {"config": {"enabled": False, "calendar_ids": ["bo@rocketshiphq.com"], "owner_uid": "u2"}, "events": {}}
    store.data[key("kartik@rocketshiphq.com")] = {"identity": {"owner_email": "kartik@rocketshiphq.com", "owner_uid": "real-k"}, "config": None, "events": {}}
    for k in list(store.data):
        store.gen[k] = 1
    factory = Factory(reachable={"ana@rocketshiphq.com", "bo@rocketshiphq.com", "kartik@rocketshiphq.com", "new@rocketshiphq.com"},
                      directory={"new@rocketshiphq.com", "gone@rocketshiphq.com", "kartik@rocketshiphq.com"})
    enrolled = calendar_runtime.enroll_organization(store, factory)
    assert enrolled == ["ana@rocketshiphq.com", "kartik@rocketshiphq.com", "new@rocketshiphq.com"]
    ana = store.data[key("ana@rocketshiphq.com")]["config"]
    assert ana["enabled"] and ana["consent_mode"] == "approved" and ana["calendar_ids"] == ["ana@rocketshiphq.com"]
    assert ana["owner_uid"] == org_placeholder_uid("ana@rocketshiphq.com")
    assert store.data[key("kartik@rocketshiphq.com")]["config"]["owner_uid"] == "real-k"
    assert store.data[key("bo@rocketshiphq.com")]["config"]["enabled"] is False  # switched off stays off
    assert key("client@example.com") not in store.data and key("gone@rocketshiphq.com") not in store.data
    # Runs at most hourly.
    assert calendar_runtime.enroll_organization(store, factory) == []


def test_enrolment_is_off_unless_configured(monkeypatch):
    monkeypatch.setenv("REEL_ORGANIZATION_DOMAIN", "rocketshiphq.com")
    monkeypatch.delenv("MEETING_ORG_AUTO_ENROLL", raising=False)
    assert calendar_runtime.enroll_organization(Store(), Factory(reachable={"a@rocketshiphq.com"})) == []


def test_only_the_verified_company_address_can_use_an_enrolled_id(org):
    uid = org_placeholder_uid("ana@rocketshiphq.com")
    assert same_account(uid, {"sub": "firebase-ana", "email": "ana@rocketshiphq.com", "email_verified": True})
    assert not same_account(uid, {"sub": "firebase-bo", "email": "bo@rocketshiphq.com", "email_verified": True})
    assert not same_account(uid, {"sub": "x", "email": "ana@rocketshiphq.com", "email_verified": False})
    assert not same_account("real-uid", {"sub": "other", "email": "ana@rocketshiphq.com", "email_verified": True})
    CalendarMeetings._verify_binding({"identity": {"owner_uid": uid}},
                                     {"sub": "firebase-ana", "email": "ana@rocketshiphq.com", "email_verified": True})
    with pytest.raises(CalendarMeetingError):
        CalendarMeetings._verify_binding({"identity": {"owner_uid": uid}},
                                         {"sub": "firebase-bo", "email": "bo@rocketshiphq.com", "email_verified": True})
