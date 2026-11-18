"""Private, idempotent Notion bridge for Reel meeting notes."""
import hashlib
import io
import json
import math
import os
import re
import uuid
from datetime import UTC, datetime

import httpx
from flask import Flask, Request, jsonify, request

from reel_organization import explicit_meeting_owner, firebase_project, is_internal_email, meeting_owner_allowed, organization_domain, trusted_origins

MAX_REQUEST = 300 * 1024
MAX_TRANSCRIPT = 95_000


class BridgeError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class NotionError(Exception):
    pass


class NotionHTTPError(NotionError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Notion request failed ({status})")


class RejectedDelivery(NotionError):
    pass


class UncertainDelivery(NotionError):
    pass


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def rich(text):
    return [{"type": "text", "text": {"content": text[i:i + 1900]}} for i in range(0, len(text), 1900)]


def blocks(meeting):
    rows = [("heading_2", "Summary"), ("paragraph", meeting["summary"] or "No summary supplied.")]
    if meeting["attendees"]:
        rows.extend([("heading_2", "Attendees"), ("paragraph", ", ".join(meeting["attendees"]))])
    rows.append(("heading_2", "Transcript"))
    transcript = "\n".join(f'[{seg["start"]:.1f}s–{seg["end"]:.1f}s] {seg["text"]}' for seg in meeting["segments"])
    rows.append(("paragraph", transcript or "No transcript supplied."))
    result = []
    for kind, text in rows:
        for i in range(0, len(text), 1900):
            result.append({"object": "block", "type": kind, kind: {"rich_text": rich(text[i:i + 1900])}})
    if len(result) > 100:
        raise BridgeError("Note exceeds Notion's atomic block limit")
    return result


def canonical(items):
    return [{"type": b["type"], "text": "".join(x.get("plain_text", x.get("text", {}).get("content", ""))
            for x in b[b["type"]].get("rich_text", []))} for b in items]


class NotionSink:
    """Notion create and full content readback, copied as a standalone safe sink."""
    def __init__(self, token, transport=None):
        self.client = httpx.Client(base_url="https://api.notion.com/v1/", timeout=30,
            follow_redirects=False, transport=transport,
            headers={"Authorization": "Bearer " + token, "Notion-Version": "2025-09-03"})

    def close(self):
        self.client.close()

    def request(self, method, path, **kwargs):
        response = self.client.request(method, path, **kwargs)
        if not response.is_success:
            raise NotionHTTPError(response.status_code)
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise UncertainDelivery("Notion returned an unreadable response") from exc

    def find(self, target, meeting_id):
        result = self.request("POST", f"data_sources/{target}/query", json={
            "filter": {"property": "Meeting ID", "rich_text": {"equals": meeting_id}}, "page_size": 100})
        pages = result.get("results", [])
        if len(pages) > 1 or result.get("has_more"):
            raise NotionError("Multiple Notion pages match this meeting")
        return pages[0] if pages else None

    def verify(self, page, target, meeting, expected, identity):
        page = self.request("GET", "pages/" + page["id"])
        if page.get("archived") or page.get("in_trash") or page.get("parent", {}).get("data_source_id") != target:
            raise NotionError("Notion page has an unexpected parent or is archived")
        props = page.get("properties", {})
        value = lambda name, kind: "".join(x.get("plain_text", x.get("text", {}).get("content", ""))
            for x in props.get(name, {}).get(kind, []))
        if value("Meeting ID", "rich_text") != identity or value("Name", "title") != meeting["title"]:
            raise NotionError("Notion page properties failed readback")
        actual, cursor = [], None
        for _ in range(20):
            params = {"page_size": 100}
            if cursor:
                params["start_cursor"] = cursor
            data = self.request("GET", "blocks/" + page["id"] + "/children", params=params)
            actual.extend(data["results"])
            if not data.get("has_more"):
                break
            cursor = data["next_cursor"]
        else:
            raise NotionError("Notion readback exceeded pagination bound")
        if canonical(actual) != canonical(expected):
            raise NotionError("Notion content readback mismatch")
        return {"page_id": page["id"], "url": page.get("url", "")}

    def deliver(self, meeting, target, identity, attempted, prepared=None):
        expected = prepared if prepared is not None else blocks(meeting)
        page = self.find(target, identity)
        if not page:
            if attempted:
                raise UncertainDelivery("Prior create is unresolved; no matching page is visible")
            if prepared is None:
                expected = self.preflight(meeting, target)
            try:
                page = self.request("POST", "pages", json={
                    "parent": {"type": "data_source_id", "data_source_id": target},
                    "properties": {"Name": {"title": rich(meeting["title"])},
                        "Meeting ID": {"rich_text": rich(identity)},
                        "Call Date": {"date": {"start": meeting["started_at"]}}}, "children": expected})
            except NotionHTTPError as exc:
                if exc.status in {400, 401, 403, 404, 422, 429}:
                    raise RejectedDelivery("Notion definitively rejected page creation") from exc
                raise UncertainDelivery("Notion create outcome is uncertain") from exc
            except (httpx.HTTPError, NotionError) as exc:
                raise UncertainDelivery("Notion create outcome is uncertain") from exc
        return self.verify(page, target, meeting, expected, identity)

    def preflight(self, meeting, target):
        """Validate atomic content and destination schema before reserving a create attempt."""
        expected = blocks(meeting)
        schema = self.request("GET", "data_sources/" + target).get("properties", {})
        for name, kind in (("Name", "title"), ("Meeting ID", "rich_text"), ("Call Date", "date")):
            if schema.get(name, {}).get("type") != kind:
                raise NotionError(f"Destination requires {name} ({kind})")
        return expected


class GCSStateStore:
    """Small CAS store: each meeting state is one generation-guarded GCS object."""
    def __init__(self, bucket, prefix):
        from google.cloud import storage
        self.bucket = storage.Client().bucket(bucket)
        self.prefix = prefix.strip("/")

    def for_sweep(self):
        # Bound both request I/O and token refresh in the scheduler's time budget.
        from google.auth.transport.requests import AuthorizedSession
        from google.cloud import storage
        original = self.bucket.client
        session = AuthorizedSession(original._credentials, refresh_timeout=1, max_refresh_attempts=0)
        client = storage.Client(project=original.project, credentials=original._credentials, _http=session)
        bounded = object.__new__(GCSStateStore)
        bounded.bucket = client.bucket(self.bucket.name)
        bounded.prefix = self.prefix
        return bounded

    def _blob(self, key):
        name = f"{self.prefix}/{key}.json" if self.prefix else f"{key}.json"
        return self.bucket.blob(name)

    def load(self, key, *, timeout=None):
        blob = self._blob(key)
        options = {} if timeout is None else {"timeout": timeout, "retry": None}
        try:
            blob.reload(**options)
        except Exception as exc:
            from google.api_core.exceptions import NotFound
            if isinstance(exc, NotFound):
                return None, 0
            raise
        generation = int(blob.generation)
        data = json.loads(blob.download_as_bytes(if_generation_match=generation, **options))
        if not isinstance(data, dict):
            raise TypeError("Receipt state is not an object")
        return data, generation

    def cas(self, key, state, generation, *, timeout=None):
        blob = self._blob(key)
        options = {} if timeout is None else {"timeout": timeout, "retry": None}
        blob.upload_from_string(json.dumps(state, separators=(",", ":")), content_type="application/json",
                                if_generation_match=generation, **options)
        blob.reload(**options)
        return int(blob.generation)


def validate(payload):
    if not isinstance(payload, dict) or set(payload) != {"id", "title", "started_at", "attendees", "summary", "segments"}:
        raise BridgeError("Meeting payload has missing or unsupported fields")
    try:
        payload["id"] = str(uuid.UUID(payload["id"]))
    except (ValueError, TypeError, AttributeError):
        raise BridgeError("id must be a UUID")
    if not isinstance(payload["title"], str) or not payload["title"].strip() or len(payload["title"]) > 200:
        raise BridgeError("title must contain 1 to 200 characters")
    try:
        dt = datetime.fromisoformat(payload["started_at"])
        if dt.tzinfo is None:
            raise ValueError()
    except (ValueError, AttributeError, TypeError):
        raise BridgeError("started_at must be an ISO8601 timestamp with timezone")
    if not isinstance(payload["attendees"], list) or len(payload["attendees"]) > 100 or any(not isinstance(x, str) or len(x) > 320 for x in payload["attendees"]):
        raise BridgeError("attendees must be a list of email strings")
    if any("@" not in x for x in payload["attendees"]):
        raise BridgeError("attendees must contain email addresses")
    if not isinstance(payload["summary"], str) or len(payload["summary"]) > MAX_TRANSCRIPT:
        raise BridgeError("summary is invalid")
    if not isinstance(payload["segments"], list) or len(payload["segments"]) > 5000:
        raise BridgeError("segments must be a list of at most 5000 entries")
    total, previous_start, previous_end = 0, -1, -1
    for segment in payload["segments"]:
        if not isinstance(segment, dict) or set(segment) != {"start", "end", "text"}:
            raise BridgeError("Each segment requires start, end, and text")
        start, end, text = segment["start"], segment["end"], segment["text"]
        if not isinstance(start, (int, float)) or isinstance(start, bool) or not isinstance(end, (int, float)) or isinstance(end, bool):
            raise BridgeError("Segment times must be numbers")
        if (not math.isfinite(start) or not math.isfinite(end) or start < 0 or end > 172800 or end < start
                or start < previous_start or end < previous_end):
            raise BridgeError("Segment times must be finite and ordered")
        if not isinstance(text, str):
            raise BridgeError("Segment text must be a string")
        total += len(text)
        previous_start, previous_end = start, end
    if total > MAX_TRANSCRIPT:
        raise BridgeError("Transcript exceeds 95000 characters")
    return payload


def parse_started_at(value):
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            raise ValueError()
        return dt
    except (ValueError, AttributeError, TypeError):
        raise BridgeError("started_at must be an ISO8601 timestamp with timezone")


def validate_index_entry(payload):
    fields = {"id", "title", "started_at", "duration_seconds", "transcript_status"}
    if not isinstance(payload, dict) or set(payload) - fields - {"share_id", "recording_source"} or not fields <= payload.keys():
        raise BridgeError("Meeting metadata has missing or unsupported fields")
    try:
        payload["id"] = str(uuid.UUID(payload["id"]))
    except (ValueError, TypeError, AttributeError):
        raise BridgeError("id must be a UUID")
    if not isinstance(payload["title"], str) or not payload["title"].strip() or len(payload["title"]) > 200:
        raise BridgeError("title must contain 1 to 200 characters")
    parse_started_at(payload["started_at"])
    duration = payload["duration_seconds"]
    if (not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration)
            or duration < 0 or duration > 172800):
        raise BridgeError("duration_seconds must be finite and between 0 and 172800")
    if payload["transcript_status"] not in {"pending", "ready", "failed", "none"}:
        raise BridgeError("transcript_status must be pending, ready, failed, or none")
    if "share_id" in payload and (not isinstance(payload["share_id"], str)
            or not re.fullmatch(r"[a-z0-9]{16,40}", payload["share_id"])):
        raise BridgeError("share_id must be 16 to 40 lowercase alphanumeric characters")
    if "recording_source" in payload and payload["recording_source"] not in {"mac", "browser"}:
        raise BridgeError("recording_source must be mac or browser")
    return payload


def validate_index_state(state):
    if not isinstance(state, dict) or set(state) != {"meetings"} or not isinstance(state["meetings"], list):
        raise BridgeError("Stored meeting index is corrupt", 503)
    if len(state["meetings"]) > 200:
        raise BridgeError("Stored meeting index exceeds its limit", 503)
    for entry in state["meetings"]:
        if (not isinstance(entry, dict)
                or set(entry) - {"id", "title", "started_at", "duration_seconds", "transcript_status",
                                 "share_id", "recording_source", "notion_url", "notion_page_id", "notion_verified"}
                or not {"id", "title", "started_at", "duration_seconds", "transcript_status"} <= entry.keys()):
            raise BridgeError("Stored meeting index is corrupt", 503)
        try:
            uuid.UUID(entry["id"])
            parse_started_at(entry["started_at"])
            if (not isinstance(entry["title"], str) or len(entry["title"]) > 200
                    or not isinstance(entry["duration_seconds"], (int, float))
                    or not math.isfinite(entry["duration_seconds"]) or not 0 <= entry["duration_seconds"] <= 172800
                    or entry["transcript_status"] not in {"pending", "ready", "failed", "none"}):
                raise ValueError("invalid meeting metadata")
            if "notion_verified" in entry and entry["notion_verified"] is not True:
                raise ValueError("invalid receipt flag")
            if any(k in entry and not isinstance(entry[k], str) for k in ("notion_url", "notion_page_id")):
                raise ValueError("invalid receipt")
            if "share_id" in entry and (not isinstance(entry["share_id"], str)
                    or not re.fullmatch(r"[a-z0-9]{16,40}", entry["share_id"])):
                raise ValueError("invalid share id")
            if "recording_source" in entry and entry["recording_source"] not in {"mac", "browser"}:
                raise ValueError("invalid recording source")
        except (ValueError, TypeError, KeyError, BridgeError) as exc:
            raise BridgeError("Stored meeting index is corrupt", 503) from exc
    return state["meetings"]


def sort_index(entries):
    return sorted(entries, key=lambda item: parse_started_at(item["started_at"]).astimezone(UTC), reverse=True)[:200]


def allowed_email(email, speech=False):
    if speech:
        return (explicit_meeting_owner(email)
                or (os.getenv("REEL_SPEECH_ALLOWED_DOMAIN") == organization_domain() and is_internal_email(email)))
    return meeting_owner_allowed(email)


def verify_firebase(token, speech=False):
    project = firebase_project()
    if not project:
        raise BridgeError("Invalid Firebase token", 401)
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.oauth2 import id_token
    claims = id_token.verify_firebase_token(token, GoogleAuthRequest(), audience=project)
    if claims.get("iss") != f"https://securetoken.google.com/{project}" or claims.get("aud") != project:
        raise BridgeError("Invalid Firebase token", 401)
    if not claims.get("sub") or claims.get("email_verified") is not True:
        raise BridgeError("Verified Firebase account required", 401)
    email = str(claims.get("email", "")).lower()
    if not allowed_email(email, speech):
        raise BridgeError("Account is not allowed", 403)
    return claims


class MemoryRequest(Request):
    def _get_file_stream(self, total_content_length, content_type, filename=None, content_length=None):
        return io.BytesIO()


def create_app(auth_verifier=None, store=None, sink_factory=None, speech_transport=None):
    app = Flask(__name__)
    from speech import MAX_SPEECH_REQUEST
    app.request_class = MemoryRequest
    app.config["MAX_CONTENT_LENGTH"] = MAX_SPEECH_REQUEST
    app.config["MAX_FORM_MEMORY_SIZE"] = MAX_SPEECH_REQUEST

    @app.before_request
    def limit_request():
        if request.path == "/summary":
            request.max_content_length = 3 * 1024 * 1024
        elif request.path != "/transcription":
            request.max_content_length = MAX_REQUEST
    app.config["JSON_SORT_KEYS"] = True
    uses_default_auth = auth_verifier is None
    auth_verifier = auth_verifier or verify_firebase

    def cors():
        return request.headers.get("Origin", "") in trusted_origins()

    def authenticated_claims(speech=False):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or len(auth) <= 7:
            raise BridgeError("Authentication required", 401)
        try:
            claims = verify_firebase(auth[7:], speech=speech) if uses_default_auth else auth_verifier(auth[7:])
        except BridgeError:
            raise
        except Exception:  # noqa: BLE001 - verifier details must not escape the auth boundary
            raise BridgeError("Invalid Firebase token", 401)
        email = str(claims.get("email", "")).lower()
        project = firebase_project()
        if (not project
                or claims.get("iss") != f"https://securetoken.google.com/{project}" or claims.get("aud") != project
                or not isinstance(claims.get("sub"), str) or not claims["sub"]
                or claims.get("email_verified") is not True or not allowed_email(email, speech)):
            raise BridgeError("Verified allowed account required", 403)
        return claims

    def update_index(claims, operation, entry=None, meeting_id=None, state_store_override=None):
        key = "index/" + sha(claims["sub"])
        index_store = state_store_override or state_store_for_request()
        for _ in range(3):
            try:
                state, generation = index_store.load(key)
                entries = [] if state is None else validate_index_state(state)
            except BridgeError:
                raise
            except Exception as exc:
                raise BridgeError("Meeting index is unavailable", 503) from exc
            entries = list(entries)
            if operation == "upsert":
                old = next((item for item in entries if item["id"] == entry["id"]), None)
                merged = dict(entry)
                if old:
                    for field in ("share_id", "recording_source", "notion_url", "notion_page_id", "notion_verified"):
                        if field in old:
                            merged[field] = old[field]
                    entries = [item for item in entries if item["id"] != entry["id"]]
                entries.append(merged)
            elif operation == "delete":
                if not any(item["id"] == meeting_id for item in entries):
                    raise BridgeError("Meeting not found", 404)
                entries = [item for item in entries if item["id"] != meeting_id]
            try:
                index_store.cas(key, {"meetings": sort_index(entries)}, generation)
                return sort_index(entries)
            except BridgeError:
                raise
            except Exception:  # noqa: BLE001,S112 - bounded CAS retry is safe for metadata only
                continue
        raise BridgeError("Meeting index changed concurrently; retry the request", 503)

    def state_store_for_request():
        if store is not None:
            return store
        bucket = os.getenv("RECEIPT_BUCKET", "")
        if not bucket:
            raise BridgeError("Meeting index is not configured", 503)
        return GCSStateStore(bucket, os.getenv("RECEIPT_PREFIX", ""))

    @app.after_request
    def add_cors(response):
        origin = request.headers.get("Origin", "")
        if cors():
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        return response

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(error="Request too large"), 413

    @app.errorhandler(BridgeError)
    def bridge_error(exc):
        return jsonify(error=str(exc)), exc.status

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    @app.route("/meetings", methods=["GET", "POST", "OPTIONS"])
    def meetings_index():
        if request.method == "OPTIONS":
            if not cors():
                return jsonify(error="Origin not allowed"), 403
            return "", 204
        claims = authenticated_claims()
        if request.method == "GET":
            key = "index/" + sha(claims["sub"])
            try:
                state, _ = state_store_for_request().load(key)
                meetings = [] if state is None else sort_index(validate_index_state(state))
            except BridgeError:
                raise
            except Exception as exc:
                raise BridgeError("Meeting index is unavailable", 503) from exc
            response = jsonify(meetings=meetings)
            response.headers["Cache-Control"] = "no-store"
            return response
        try:
            payload = validate_index_entry(json.loads(request.get_data(cache=True)))
        except BridgeError:
            raise
        except (ValueError, UnicodeDecodeError, TypeError):
            raise BridgeError("Invalid JSON meeting metadata")
        result = update_index(claims, "upsert", entry=payload)
        response = jsonify(meetings=result)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/meetings/<meeting_id>", methods=["DELETE", "OPTIONS"])
    def meeting_metadata(meeting_id):
        if request.method == "OPTIONS":
            if not cors():
                return jsonify(error="Origin not allowed"), 403
            return "", 204
        claims = authenticated_claims()
        try:
            canonical_id = str(uuid.UUID(meeting_id))
        except ValueError:
            raise BridgeError("id must be a UUID")
        result = update_index(claims, "delete", meeting_id=canonical_id)
        response = jsonify(meetings=result)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/notion/preview", methods=["POST", "OPTIONS"])
    @app.route("/notion/deliver", methods=["POST", "OPTIONS"])
    def meeting_route():
        if request.method == "OPTIONS":
            if not cors():
                return jsonify(error="Origin not allowed"), 403
            return "", 204
        claims = authenticated_claims()
        raw = request.get_data(cache=True)
        if len(raw) > MAX_REQUEST:
            raise BridgeError("Request too large", 413)
        try:
            payload = validate(json.loads(raw))
        except (ValueError, UnicodeDecodeError, TypeError):
            raise BridgeError("Invalid JSON payload")
        if request.path.endswith("preview"):
            return jsonify(name="Private calls", kind="private")

        return jsonify(deliver_notes(claims, payload))

    def deliver_notes(claims, payload):
        payload = validate(payload)
        target = os.getenv("NOTION_DEFAULT_DATA_SOURCE_ID", "")
        token = os.getenv("NOTION_TOKEN", "")
        if not target or not token or store is None and not os.getenv("RECEIPT_BUCKET"):
            raise BridgeError("Delivery service is not configured", 503)
        state_store = store or GCSStateStore(os.environ["RECEIPT_BUCKET"], os.getenv("RECEIPT_PREFIX", ""))
        sink = (sink_factory or NotionSink)(token)
        identity = "reel_" + sha(claims["sub"])[:16] + "_" + payload["id"]
        target_key = sha(identity)
        body_hash = sha(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False))
        try:
            state, generation = state_store.load(target_key)
            previous_receipt = None
            if state is not None:
                if (not isinstance(state, dict) or not {"target", "body_hash", "status", "attempts"} <= state.keys()
                        or state.get("status") not in {"pending", "delivered", "rejected"}
                        or not isinstance(state.get("target"), str) or not isinstance(state.get("body_hash"), str)
                        or not isinstance(state.get("attempts"), int) or state["attempts"] < 1):
                    raise BridgeError("Stored delivery state is invalid; refusing to create", 503)
                if state["target"] != target:
                    raise BridgeError("Meeting identity is already bound to another destination", 409)
            if state is None or (isinstance(state, dict) and state.get("status") == "rejected"):
                prepared = sink.preflight(payload, target)
                attempts = int(state.get("attempts", 0)) + 1 if state else 1
                state = {"target": target, "body_hash": body_hash, "status": "pending", "attempts": attempts}
                generation = state_store.cas(target_key, state, generation)
                attempted = False
            else:
                prepared = None
                if state.get("body_hash") != body_hash:
                    raise BridgeError("Meeting identity is already bound to different content", 409)
                if state.get("status") == "delivered" and (not isinstance(state.get("page_id"), str)
                        or not state.get("page_id") or not isinstance(state.get("url"), str) or not state.get("url")):
                    raise BridgeError("Stored delivery receipt is invalid; refusing to create", 503)
                attempted = True
                previous_receipt = (state.get("page_id"), state.get("url")) if state.get("status") == "delivered" else None
                state["attempts"] += 1
                generation = state_store.cas(target_key, state, generation)
            receipt = sink.deliver(payload, target, identity, attempted, prepared=prepared)
            if previous_receipt and previous_receipt != (receipt["page_id"], receipt["url"]):
                raise BridgeError("Stored Notion receipt does not match verified page", 409)
            state.update({"status": "delivered", "page_id": receipt["page_id"], "url": receipt["url"]})
            state_store.cas(target_key, state, generation)
            duration = max((segment["end"] for segment in payload["segments"]), default=0)
            transcript_status = "ready" if payload["summary"] or any(s["text"] for s in payload["segments"]) else "none"
            update_index(claims, "upsert", entry={
                "id": payload["id"], "title": payload["title"], "started_at": payload["started_at"],
                "duration_seconds": duration, "transcript_status": transcript_status,
                "notion_url": receipt["url"], "notion_page_id": receipt["page_id"], "notion_verified": True,
            }, state_store_override=state_store)
            return dict(url=receipt["url"], page_id=receipt["page_id"], verified=True)
        except BridgeError:
            raise
        except RejectedDelivery:
            state["status"] = "rejected"
            try:
                state_store.cas(target_key, state, generation)
            except Exception as exc:
                raise BridgeError("Rejected delivery could not be recorded; retry will reconcile first", 503) from exc
            raise BridgeError("Notion rejected delivery; corrected content may be retried", 422)
        except UncertainDelivery:
            raise BridgeError("Delivery outcome is uncertain; retry will reconcile before any create", 503)
        except Exception:  # noqa: BLE001 - includes storage races and readback failures; fail closed
            # Includes GCS CAS races and readback failures. Never retry a create blindly.
            raise BridgeError("Delivery could not be confirmed; retry will reconcile first", 503)
        finally:
            sink.close()

    from speech import install_speech_routes
    install_speech_routes(app, lambda: authenticated_claims(speech=True), cors, speech_transport)

    from calendar_runtime import install_calendar_routes
    install_calendar_routes(app, authenticated_claims, state_store_for_request, deliver_notes)
    return app


app = create_app()
