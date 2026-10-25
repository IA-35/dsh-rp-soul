"""End-to-end helpers: a temp data dir, a persona payload, a valid commit."""

import itertools
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fixture


_COUNTER = itertools.count(1)


def rid(prefix="r"):
    """A fresh request id: the engine replays by id, so tests must not reuse one."""
    return "%s_%s_%03d" % (prefix, os.urandom(4).hex(), next(_COUNTER))


def temp_dir():
    return tempfile.mkdtemp(prefix="rp-soul-e2e-")


def persona_payload():
    """What node hands over: front-matter object + prose."""
    return {"front": dict(fixture.PERSONA), "prose": fixture.PERSONA["prose"], "title": fixture.PERSONA["title"],
            "persona_id": fixture.PERSONA["id"]}


def commit(session, *, ops=None, mode="continue", player_input="", summary=None, tags=None, **extra):
    """A commit body that passes the domain checks for a quiet turn."""
    body = {
        "session_id": session["session_id"],
        "request_id": rid("r_turn"),
        "expected_revision": session["revision"],
        "turns": [
            {
                "action_mode": mode,
                "player_input": player_input,
                "operations": ops or [],
                "content_tags": tags or [],
                "summary": summary or "他坐着没说话，雨还在下。",
                "open_action": "她等着他开口。",
            }
        ],
    }
    for key, value in extra.items():
        body["turns"][0][key] = value
    return body


def start(sidecar):
    """new-game, returning (session_id, revision, data)."""
    data = sidecar.ok("new-game", {"request_id": rid("r_new"), "persona": persona_payload(), "seed": 7})
    return data["session_id"], data["revision"], data
