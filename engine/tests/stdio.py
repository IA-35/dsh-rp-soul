"""Drive the sidecar the way node does: one JSON line in, one out."""

import json
import os
import subprocess
import sys

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ENV = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
for key in ("RP_SOUL_ENGINE_HOME",):
    ENV.pop(key, None)


class Sidecar:
    """A long-lived `python -m rp_soul_engine` process, addressed by request id."""

    def __init__(self, data_dir, python=None):
        self.data_dir = data_dir
        self.python = python or sys.executable
        self.proc = None
        self.count = 0

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.close()

    def start(self):
        self.proc = subprocess.Popen(
            [self.python, "-m", "rp_soul_engine", "--data-dir", self.data_dir],
            cwd=ENGINE_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=ENV,
        )
        return self

    def close(self):
        if self.proc is None:
            return
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self.proc = None

    def raw(self, line):
        """Send one raw line (bytes or str) and return the parsed reply."""
        if isinstance(line, str):
            line = line.encode("utf-8")
        self.proc.stdin.write(line if line.endswith(b"\n") else line + b"\n")
        self.proc.stdin.flush()
        reply = self.proc.stdout.readline()
        if not reply:
            raise AssertionError("sidecar closed stdout: %s" % self.proc.stderr.read().decode("utf-8", "replace")[:800])
        return json.loads(reply.decode("utf-8"))

    def call(self, command, payload=None, expect_ok=True):
        self.count += 1
        request = {"id": "t%d" % self.count, "command": command}
        if payload is not None:
            request["payload"] = payload
        reply = self.raw(json.dumps(request, ensure_ascii=False))
        assert reply.get("id") == request["id"], "reply id %r != %r" % (reply.get("id"), request["id"])
        if expect_ok:
            assert reply["ok"] is True, "command %s failed: %s" % (command, json.dumps(reply.get("error"), ensure_ascii=False)[:900])
        else:
            assert reply["ok"] is False, "command %s unexpectedly succeeded" % command
        return reply

    def ok(self, command, payload=None):
        return self.call(command, payload)["data"]

    def fail(self, command, payload=None):
        return self.call(command, payload, expect_ok=False)["error"]
