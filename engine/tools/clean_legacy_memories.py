"""一次性清理：引擎里残留的旧格式事实。

清 facts 表里 `feiyu.response.tNN` —— 旧版「每次 npc_response 都落一条事实」的残留，
现在的代码只在 response=='surface' 时记一条，key 也不再是这种格式。
（lite 没有记忆层：旧存档里的记忆条读进来就扔掉，不用再单独清。）

走引擎自己的命令入口（delete-fact），所以每条都会留审计。

用法：
    python -X utf8 tools/clean_legacy_memories.py            # 只看要删什么
    python -X utf8 tools/clean_legacy_memories.py --apply    # 真删
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = r"C:/Users/17711/.dsh/rp-soul/engine"
SESSION = "s_86a39578"

APPLY = "--apply" in sys.argv


def call(command, payload):
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", "-m", "rp_soul_engine", "--data-dir", DATA_DIR, command],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(ROOT),
    )
    out = proc.stdout.strip()
    if not out:
        raise SystemExit("引擎没有返回：\n%s\n%s" % (proc.stdout, proc.stderr))
    envelope = json.loads(out)
    if not envelope.get("ok"):
        raise SystemExit("命令失败 %s：%s" % (command, json.dumps(envelope, ensure_ascii=False)))
    return envelope["data"]


def main():
    facts = call("debug-facts", {"session_id": SESSION})
    legacy = [row for row in facts["rows"] if row["key"].startswith("feiyu.response.")]

    print("要删的事实 %d 条：" % len(legacy))
    for row in legacy:
        print("  %s %s  %s" % (row["id"], row["key"], row["text"][:48]))
    if not APPLY:
        print("\n（只看了看。加 --apply 才真删。）")
        return

    revision = facts["revision"]
    for index, row in enumerate(legacy, 1):
        data = call("delete-fact", {
            "session_id": SESSION,
            "request_id": "cleanfact%03d" % index,
            "expected_revision": revision,
            "fact_id": row["id"],
        })
        revision = data["revision"]
        print("删掉事实 %s（revision %d）" % (row["id"], revision))

    after_facts = call("debug-facts", {"session_id": SESSION})
    print("\n清理后：事实 %d 条" % after_facts["count"])


if __name__ == "__main__":
    main()
