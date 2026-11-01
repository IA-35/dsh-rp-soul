"""一次性清理：引擎里残留的旧格式记忆。

清两类：
1. facts 表里 `feiyu.response.tNN` —— 旧版「每次 npc_response 都落一条事实」的残留，
   现在的代码只在 response=='surface' 时记一条，key 也不再是这种格式。
2. 「刚刚」层里 type=='action' 的条目 —— passing action 按设计最多活 24 小时就该丢，
   但它们会堆在刚刚层让设置页变成一串动作流水账；对话类条目不动。

走引擎自己的命令入口（delete-fact / delete-memory），所以每条都会留审计。

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
    memories = call("debug-memories", {"session_id": SESSION})
    actions = [e for e in memories["entries"] if e["layer"] == "now" and e["type"] == "action"]

    print("要删的事实 %d 条：" % len(legacy))
    for row in legacy:
        print("  %s %s  %s" % (row["id"], row["key"], row["text"][:48]))
    print("要删的动作记忆 %d 条：" % len(actions))
    for entry in actions:
        print("  %s t%s  %s" % (entry["id"], entry.get("turn"), entry["content"][:48]))
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

    for index, entry in enumerate(actions, 1):
        data = call("delete-memory", {
            "session_id": SESSION,
            "request_id": "cleanmem%03d" % index,
            "expected_revision": revision,
            "memory_id": entry["id"],
            "reason": "旧动作流水，清理残留",
        })
        revision = data["revision"]
        print("删掉记忆 %s（revision %d）" % (entry["id"], revision))

    after_mem = call("debug-memories", {"session_id": SESSION})
    after_facts = call("debug-facts", {"session_id": SESSION})
    print("\n清理后：记忆 %s；事实 %d 条"
          % (json.dumps(after_mem["counts"], ensure_ascii=False), after_facts["count"]))


if __name__ == "__main__":
    main()
