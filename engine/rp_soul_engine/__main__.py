"""Sidecar entry point: one JSON object per line on stdin, one per line out.

    {"id": "c1", "command": "get-context", "payload": {...}}
 -> {"id": "c1", "ok": true, "data": {...}}
 -> {"id": "c1", "ok": false, "error": {"code": "...", ...}}

The process stays up for the whole chat: node spawns it once, keeps the pipe
open, and pays the import cost once. A line that is not JSON, or a command
that is not known, gets an error envelope with the same id and the loop keeps
going; nothing kills the process but EOF or SIGTERM.

One-shot mode (`python -m rp_soul_engine doctor`) exists for probing from a
shell or from node before the pipe is set up; it reads the payload from stdin
when there is one and exits with the error code for the failure class.
"""

import json
import os
import re
import sys
import time
import traceback

from . import schema as S
from .errors import (
    EXIT_CODES,
    EXIT_INTERNAL,
    INTERNAL_ERROR,
    INVALID_INPUT,
    AppError,
    detail,
    exit_code_for,
)
from .application import commands as COMMANDS
from .jsonio import dumps, loads_strict

ENCODING_CHECK = "汉字"
ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def new_request_id():
    return "r_" + os.urandom(6).hex()


def log_internal_error(data_dir, error_id, text):
    """Append to logs/runtime.log (rotated by size). Returns the path or None."""
    try:
        path = os.path.join(data_dir, "logs", "runtime.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) > 1024 * 1024:
            for index in (2, 1):
                older = "%s.%d" % (path, index)
                if os.path.exists(older):
                    os.replace(older, "%s.%d" % (path, index + 1))
            os.replace(path, path + ".1")
        with open(path, "ab") as handle:
            stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
            handle.write(("[%s] %s\n%s\n" % (stamp, error_id, text)).encode("utf-8", "backslashreplace"))
        return path
    except OSError:
        return None


def _check_encoding(payload):
    """Any input may carry "encoding_check": "汉字". A terminal that mangles
    Chinese on the way in still yields valid JSON, so without this the
    player's words would be saved broken."""
    if not isinstance(payload, dict) or "encoding_check" not in payload:
        return
    got = payload.pop("encoding_check")
    if got != ENCODING_CHECK:
        raise AppError(
            INVALID_INPUT,
            "中文在传入途中被改坏了",
            [detail("$.encoding_check", "应为“%s”，收到 %s" % (ENCODING_CHECK, json.dumps(got, ensure_ascii=False)),
                    "这个终端改坏了中文：改用 UTF-8 写 JSON 再传", INVALID_INPUT)],
        )


def salvage_id(line):
    """Best-effort "id" from a line that is not valid JSON."""
    if not isinstance(line, str):
        return None
    match = re.search(r'"id"\s*:\s*"([^"]{1,80})"', line)
    return match.group(1) if match else None


def execute_line(ctx_factory, line):
    """Run one request. Returns (envelope dict, exit code). Never raises."""
    request_id = None
    ctx = None
    # 解析是否已经走过。ValueError 只有在解析**之前**抛出才是「JSON 不合法」：
    # loads_strict 内部已把 json 的 ValueError 转成 AppError，所以解析之后的
    # ValueError 一定是 handler（clock.parse_iso / mood.add_thought / …）抛的，
    # 不能再谎报成 JSON 错误，否则模型拿到完全误导的提示、真错误也不进日志。
    parsed = False
    try:
        request = loads_strict(line, "请求")
        parsed = True
        if not isinstance(request, dict):
            raise AppError(INVALID_INPUT, "每一行必须是一个 JSON 对象", [detail("$", "顶层应为对象", None)])
        request_id = request.get("id")
        name = request.get("command")
        if not isinstance(name, str) or not name:
            raise AppError(INVALID_INPUT, "缺少 command",
                           [detail("$.command", "必须给出命令名", "可用命令：%s" % "、".join(sorted(COMMANDS.COMMANDS)))])
        command = COMMANDS.get(name)
        if command is None:
            raise AppError(INVALID_INPUT, "未知命令：%s" % name,
                           [detail("$.command", "未知命令：%s" % name,
                                   "可用命令：%s" % "、".join(sorted(COMMANDS.COMMANDS)))])
        payload = request.get("payload")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise AppError(INVALID_INPUT, "payload 必须是 JSON 对象", [detail("$.payload", "顶层应为对象", None)])
        _check_encoding(payload)
        if command.input == "none":
            _normalized, errors = S.validate(S.EMPTY, payload)
            if errors:
                raise AppError(INVALID_INPUT, "命令 %s 不接受这些输入" % name, errors)
        ctx = ctx_factory(request.get("data_dir"), bool(request.get("debug")))
        module = __import__(command.module, fromlist=[command.func])
        data = getattr(module, command.func)(ctx, dict(payload))
        if "next_request_id" not in data:
            data["next_request_id"] = new_request_id()
        return {"id": request_id, "ok": True, "data": data, "error": None}, 0
    except AppError as err:
        body = err.to_dict()
        body.setdefault("next_request_id", new_request_id())
        # A bad line still has to come back under its own id, or the caller
        # cannot match the reply to the request it is waiting on.
        if request_id is None:
            request_id = salvage_id(line)
        return {"id": request_id, "ok": False, "data": None, "error": body}, exit_code_for(err.code)
    except ValueError as err:
        if parsed:
            # handler 里抛的 ValueError：真错误，按内部错误处理并留日志。
            error_id = "E" + time.strftime("%Y%m%d%H%M%S") + os.urandom(3).hex()
            log = None
            if ctx is not None:
                log = log_internal_error(ctx.data_dir, error_id, traceback.format_exc())
            hint = "状态没有改变；查看日志 %s" % log if log else "状态没有改变"
            body = {"code": INTERNAL_ERROR, "message": "未预期错误（编号 %s）" % error_id,
                    "details": [detail("$", "%s: %s" % (type(err).__name__, err), hint)],
                    "error_id": error_id, "log": log, "next_request_id": new_request_id()}
            return {"id": request_id, "ok": False, "data": None, "error": body}, EXIT_INTERNAL
        # 走到这里说明请求行根本没解析成功。
        body = {"code": INVALID_INPUT, "message": "输入不是合法 JSON：%s" % err,
                "details": [detail("$", str(err), "检查引号与转义")], "next_request_id": new_request_id()}
        return {"id": salvage_id(line) if request_id is None else request_id, "ok": False, "data": None,
                "error": body}, EXIT_CODES[INVALID_INPUT]
    except Exception:
        error_id = "E" + time.strftime("%Y%m%d%H%M%S") + os.urandom(3).hex()
        log = None
        if ctx is not None:
            log = log_internal_error(ctx.data_dir, error_id, traceback.format_exc())
        hint = "状态没有改变；查看日志 %s" % log if log else "状态没有改变"
        body = {"code": INTERNAL_ERROR, "message": "未预期错误（编号 %s）" % error_id,
                "details": [detail("$", "未预期错误", hint)], "error_id": error_id, "log": log,
                "next_request_id": new_request_id()}
        return {"id": request_id, "ok": False, "data": None, "error": body}, EXIT_INTERNAL
    finally:
        if ctx is not None:
            ctx.close()


def _write(stream, text):
    stream.write(text.encode("utf-8", "backslashreplace"))
    stream.flush()


def _factory(data_dir, debug):
    from .application.context import Context

    return lambda request_dir, request_debug: Context(ENGINE_ROOT, request_dir or data_dir, None, request_debug or debug)


def serve(stream_in, stream_out, data_dir=None, debug=False):
    """The stdio loop. Returns the number of requests served."""
    factory = _factory(data_dir, debug)
    served = 0
    for line in stream_in:
        text = line.decode("utf-8", "replace") if isinstance(line, bytes) else line
        if not text.strip():
            continue
        envelope, _code = execute_line(factory, text)
        served += 1
        try:
            _write(stream_out, dumps(envelope) + "\n")
        except (OSError, ValueError):
            _write(stream_out, dumps({"id": envelope.get("id"), "ok": False, "data": None,
                                      "error": {"code": INTERNAL_ERROR, "message": "结果无法写成 JSON",
                                                "details": [detail("$", "结果不是纯 JSON", None)],
                                                "next_request_id": new_request_id()}}) + "\n")
    return served


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    data_dir = None
    debug = False
    once = None
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--data-dir" and index + 1 < len(argv):
            data_dir = argv[index + 1]
            index += 2
        elif item.startswith("--data-dir="):
            data_dir = item.split("=", 1)[1]
            index += 1
        elif item == "--debug":
            debug = True
            index += 1
        elif item == "--once" and index + 1 < len(argv):
            once = argv[index + 1]
            index += 2
        elif item in ("--help", "-h"):
            sys.stdout.write(__doc__ or "")
            return 0
        elif item.startswith("-"):
            sys.stderr.write("unknown flag: %s\n" % item)
            return EXIT_CODES[INVALID_INPUT]
        else:
            once = item
            index += 1
    if once is not None:
        stream_in = getattr(sys.stdin, "buffer", None)
        raw = b""
        if stream_in is not None:
            try:
                raw = stream_in.read()
            except OSError:
                raw = b""
        payload_text = raw.decode("utf-8", "replace").strip()
        request = {"id": "cli", "command": once}
        if payload_text:
            request["payload"] = loads_strict(payload_text, "stdin")
        if data_dir:
            request["data_dir"] = data_dir
        envelope, code = execute_line(_factory(data_dir, debug), json.dumps(request, ensure_ascii=False))
        _write(getattr(sys.stdout, "buffer", sys.stdout), dumps(envelope) + "\n")
        return code
    stream_in = getattr(sys.stdin, "buffer", sys.stdin)
    stream_out = getattr(sys.stdout, "buffer", sys.stdout)
    try:
        serve(stream_in, stream_out, data_dir, debug)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
