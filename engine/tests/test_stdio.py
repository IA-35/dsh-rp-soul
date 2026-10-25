"""The sidecar protocol: one JSON object per line, ids echoed, errors shaped,
and the process surviving garbage. This is the contract node relies on."""

import json
import os
import shutil

import e2e
from harness import check, run
from stdio import Sidecar

DATA = e2e.temp_dir()


def with_sidecar(fn):
    def inner():
        with Sidecar(DATA) as s:
            fn(s)

    return inner


def replies_echo_the_id(s):
    for index in range(3):
        reply = s.raw(json.dumps({"id": "x%d" % index, "command": "version"}, ensure_ascii=False))
        assert reply["id"] == "x%d" % index, reply


def version_shape(s):
    data = s.ok("version")
    assert data["engine"] == "0.1.0", data
    assert data["save_format"] == "rp-soul-save", data
    assert data["schema_version"] == 1, data
    assert data["python"]["ok"] is True, data
    assert data["sqlite"]["ok"] is True, data


def command_table(s):
    names = {c["name"] for c in s.ok("list-commands")["commands"]}
    for expected in ("new-game", "commit-turn", "get-context", "undo-turn", "save-slot", "load-slot",
                     "list-slots", "delete-slot", "debug-mood", "debug-delete-thought", "check-persona",
                     "preview-persona", "export-save", "import-save", "status", "doctor"):
        assert expected in names, "missing command %s in %s" % (expected, sorted(names))
    for gone in ("list-worlds", "save-world", "my-worlds", "delete-world"):
        assert gone not in names, "world command %s must not exist" % gone


def every_command_names_its_module(s):
    for command in s.ok("list-commands")["commands"]:
        assert command["input"] in ("none", "optional", "required"), command
        assert command["category"], command
        assert command["summary"], command


def unknown_command_is_reported(s):
    err = s.fail("no-such-command")
    assert err["code"] == "INVALID_INPUT", err
    assert "未知命令" in err["message"], err
    assert err["next_request_id"].startswith("r_"), err


def missing_command_is_reported(s):
    reply = s.raw(json.dumps({"id": "z1"}))
    assert reply["ok"] is False, reply
    assert reply["error"]["code"] == "INVALID_INPUT", reply


def broken_json_keeps_the_loop_alive(s):
    reply = s.raw("{\"id\": \"bad\", \"command\": ")
    assert reply["id"] == "bad", reply
    assert reply["ok"] is False, reply
    assert reply["error"]["code"] == "INVALID_INPUT", reply
    # and the next well-formed line still works
    assert s.ok("version")["engine"] == "0.1.0"


def non_object_payload_is_rejected(s):
    reply = s.raw(json.dumps({"id": "p1", "command": "version", "payload": [1, 2, 3]}))
    assert reply["ok"] is False, reply
    assert "payload" in reply["error"]["message"], reply


def blank_lines_are_skipped(s):
    s.proc.stdin.write(b"\n\n   \n")
    s.proc.stdin.flush()
    reply = s.raw(json.dumps({"id": "after-blank", "command": "version"}))
    assert reply["id"] == "after-blank", reply


def encoding_check_passes(s):
    reply = s.raw(json.dumps({"id": "enc1", "command": "version", "payload": {"encoding_check": "汉字"}}, ensure_ascii=False))
    assert reply["ok"] is True, reply


def encoding_check_catches_mojibake(s):
    reply = s.raw(json.dumps({"id": "enc2", "command": "version", "payload": {"encoding_check": "??"}}, ensure_ascii=False))
    assert reply["ok"] is False, reply
    assert "中文在传入途中被改坏了" in reply["error"]["message"], reply


def two_identical_calls_both_answer(s):
    """Version is a read: it answers twice, and only the id bookkeeping differs."""
    request = json.dumps({"id": "dup", "command": "version"}, ensure_ascii=False)
    first = s.raw(request)
    second = s.raw(request)
    assert first["ok"] and second["ok"], (first, second)
    for key in ("engine", "save_format", "schema_version", "rng_version"):
        assert first["data"][key] == second["data"][key], (first, second)


def doctor_creates_schema(s):
    data = s.ok("doctor")
    assert data["ok"] is True, data
    assert data["db"]["schema"] == 1, data
    assert data["db"]["target_schema"] == 1, data
    assert data["db"]["integrity"] == "ok", data
    again = s.ok("doctor")
    assert again["db"]["report"]["migrated"] is False, again


def data_dir_is_outside_the_package(s):
    data = s.ok("version")
    assert "rp_soul_engine" not in data["data_dir"], data
    assert data["data_dir_source"] == "arg", data


check("replies echo the request id", with_sidecar(replies_echo_the_id))
check("version reports the format and the runtime floor", with_sidecar(version_shape))
check("the command table is the game, not the old world pack", with_sidecar(command_table))
check("every command is documented", with_sidecar(every_command_names_its_module))
check("unknown command is an INVALID_INPUT", with_sidecar(unknown_command_is_reported))
check("missing command is an INVALID_INPUT", with_sidecar(missing_command_is_reported))
check("broken JSON does not kill the process", with_sidecar(broken_json_keeps_the_loop_alive))
check("payload must be an object", with_sidecar(non_object_payload_is_rejected))
check("blank lines are skipped", with_sidecar(blank_lines_are_skipped))
check("encoding_check passes when Chinese survives", with_sidecar(encoding_check_passes))
check("encoding_check catches mojibake", with_sidecar(encoding_check_catches_mojibake))
check("two identical reads both answer", with_sidecar(two_identical_calls_both_answer))
check("doctor migrates the schema once", with_sidecar(doctor_creates_schema))
check("the data dir is not inside the package", with_sidecar(data_dir_is_outside_the_package))

run("stdio")
