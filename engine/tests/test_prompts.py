"""同一条记忆文案写在三个地方，字数上限必须跟代码一致。

写三处是跨进程边界的代价：引擎（domain/turn.py）执法、桥接层（lib/engine-bridge.js）
告知模型、报错文案（modules/memory.py）在驳回时说同一件事。它们对不上时，模型会照着
一个说法写、被另一个说法驳回，所以这里把三处的数字钉死。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from rp_soul_engine.domain import memories as MEM
from rp_soul_engine.domain import turn as TU
from tests.harness import check, run


def _text(path):
    return (ROOT / path).read_text(encoding="utf-8")


def the_two_lengths_agree_everywhere():
    fold = MEM.SUMMARY_MAX
    diary = MEM.DIARY_MAX
    fields = TU.commit_fields()
    for key, limit in (("memory_fold", fold), ("memory_diary", diary)):
        spec = fields[key].spec
        spec = getattr(spec, "inner", spec)          # Nullable 包了一层
        assert spec.max_len == limit, "%s 的 max_len 是 %r，应是 %d" % (key, spec.max_len, limit)

    bridge = _text("lib/engine-bridge.js")
    assert "≤%d 字" % fold in bridge, "桥接层的 ABM 汇总字数跟 SUMMARY_MAX=%d 对不上" % fold
    assert "≤%d 字" % diary in bridge, "桥接层的日记字数跟 DIARY_MAX=%d 对不上" % diary

    errors = _text("engine/rp_soul_engine/modules/memory.py")
    assert "≤%d 字" % fold in errors, "报错文案的 ABM 汇总字数对不上"
    assert "≤%d 字" % diary in errors, "报错文案的日记字数对不上"


def the_documentation_agrees():
    doc = _text("docs/memory-design.md")
    assert "≤%d 字" % MEM.SUMMARY_MAX in doc or "%d 字" % MEM.SUMMARY_MAX in doc, "文档里的 ABM 汇总字数对不上"
    assert "≤%d 字" % MEM.DIARY_MAX in doc or "%d 字" % MEM.DIARY_MAX in doc, "文档里的日记字数对不上"


def the_layer_names_in_prose_are_real():
    """文案里提到的层名必须是 LAYER_LABELS 里真有的，模型照着找才找得到。"""
    names = set(MEM.LAYER_LABELS.values())
    for path in ("engine/rp_soul_engine/modules/memory.py", "lib/engine-bridge.js"):
        text = _text(path)
        for quoted in re.findall(r"「([^」]{2,4})」", text):
            if quoted in ("ABM", "SCM", "CLPA", "刚刚", "今日", "那些事", "这几天"):
                assert quoted in names, "%s 里提到「%s」，但它不是一层" % (path, quoted)


check("the two memory lengths agree in code, bridge and errors", the_two_lengths_agree_everywhere)
check("the documentation agrees on the lengths", the_documentation_agrees)
check("the layer names in prose are real", the_layer_names_in_prose_are_real)
run("prompts")
