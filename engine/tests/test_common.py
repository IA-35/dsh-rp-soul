"""常识库：关键词 + 权重 + 一条常识，全局共享，不属于任何一局。

两半：域层是纯函数（匹配、排序、渲染、合并），端到端走一遍设置页那五个命令，
看它是不是真的会出现在上下文里、删掉之后是不是真的不再出现。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rp_soul_engine.domain import common as CM
from tests.harness import check, run


def entry(fid, keys, weight, content):
    return CM.make(fid, keys, weight, content)


# ---------------------------------------------------------------- 域层：匹配

def a_keyword_only_counts_where_it_stands():
    """「ds」这种两字母关键词在中文里不能被当成命中：按词边界比。"""
    row = entry("c1", ["ds"], 0.8, "DS 是深度求索。")
    assert CM.hits(row, "DS 给我写个代码"), "全大写也该命中"
    assert CM.hits(row, "用 ds 写"), "两侧有空格，算独立出现"
    assert not CM.hits(row, "hands"), "英文词尾里的 ds 不算"
    assert not CM.hits(row, "gods"), "英文单词内部不算"
    assert not CM.hits(row, "我们 adsl 一下"), "英文串内部不算"


def a_chinese_keyword_matches_inside_a_sentence():
    row = entry("c1", ["米饭"], 0.6, "他爱吃米饭。")
    assert CM.hits(row, "今天煮点米饭吧")
    assert not CM.hits(row, "今天煮点面条吧")


def nothing_is_hit_without_a_cue():
    row = entry("c1", ["ds"], 0.8, "DS 是深度求索。")
    assert not CM.hits(row, "")
    assert not CM.hits(row, None)
    assert CM.select([row], "") == []


# ---------------------------------------------------------------- 域层：排序

def the_heavier_one_comes_first():
    """「DS 给我写个关于米饭的代码」同时命中两条，按权重从高到低。"""
    rows = [
        entry("c1", ["米饭"], 0.4, "他爱吃米饭。"),
        entry("c2", ["ds", "deepseek"], 0.9, "DS 是深度求索的大模型。"),
    ]
    got = CM.select(rows, "DS 给我写个关于米饭的代码")
    assert [e["id"] for e in got] == ["c2", "c1"], got


def an_equally_heavy_entry_with_more_keywords_wins():
    rows = [
        entry("c1", ["ds"], 0.5, "短的。"),
        entry("c2", ["ds", "deepseek", "深度求索"], 0.5, "长的。"),
    ]
    got = CM.select(rows, "ds 和 deepseek 怎么样")
    assert [e["id"] for e in got] == ["c2", "c1"], got


def only_a_few_are_carried():
    rows = [entry("c%d" % n, ["ds"], 0.5, "第 %d 条。" % n) for n in range(1, 8)]
    assert len(CM.select(rows, "ds", 2)) == 2
    assert len(CM.select(rows, "ds", 4)) == 4
    assert len(CM.select(rows, "ds", CM.LIMIT_DEFAULT)) == CM.LIMIT_DEFAULT


def the_setting_is_clamped_to_the_allowed_range():
    assert CM.limit_of(3) == 3
    assert CM.limit_of(0) == CM.LIMIT_RANGE[0]
    assert CM.limit_of(99) == CM.LIMIT_RANGE[1]
    assert CM.limit_of(None) == CM.LIMIT_DEFAULT
    assert CM.limit_of("乱写") == CM.LIMIT_DEFAULT


# ---------------------------------------------------------------- 域层：渲染

def what_is_carried_looks_like_a_short_table():
    rows = [entry("c1", ["ds", "deepseek"], 0.8, "deepseek 是深度求索旗下的大语言模型。")]
    text = CM.render(CM.select(rows, "ds 帮我看看"), "ds 帮我看看")
    assert text.startswith("### 常识"), text
    assert "\n- ds： deepseek 是深度求索旗下的大语言模型。" in text, text


def nothing_matched_renders_nothing():
    rows = [entry("c1", ["ds"], 0.8, "DS 是深度求索。")]
    assert CM.render(CM.select(rows, "今天天气不错"), "今天天气不错") == ""


# ---------------------------------------------------------------- 域层：写入

def what_the_model_says_is_normalized():
    got = CM.from_model({"key": ["DS ", "deepseek", "ds"], "weight": 9, "content": "  一句话  "}, 3)
    assert got["key"] == ["ds", "deepseek"], got["key"]
    assert got["weight"] == 1.0, "权重超上界就夹到 1.0"
    assert got["content"] == "一句话"
    assert got["turn"] == 3 and got["origin"] == "fold"


def a_half_written_entry_is_ignored():
    assert CM.from_model({"key": ["ds"]}, 1) is None, "没内容"
    assert CM.from_model({"content": "有内容没关键词"}, 1) is None, "没关键词"
    assert CM.from_model({"key": [], "content": "有内容"}, 1) is None
    assert CM.from_model("不是字典", 1) is None


def the_same_keywords_update_instead_of_pile_up():
    """还挂着等你确认的那条，模型再提一次就用新说法覆盖，不另起一条。"""
    rows = [dict(entry("c1", ["ds", "deepseek"], 0.5, "旧的说法。"), pending=True)]
    fresh = [CM.from_model({"key": ["deepseek", "ds"], "weight": 0.9, "content": "新的说法。"}, 4)]
    got, touched = CM.merge(rows, fresh, CM.next_id)
    assert len(got) == 1, got
    assert got[0]["content"] == "新的说法。" and got[0]["weight"] == 0.9, got[0]
    assert got[0]["pending"] is True, got[0]
    assert touched == ["c1"], touched


def the_model_cannot_overwrite_what_you_confirmed():
    """你确认过（或手动加）的那条，模型提同样的关键词也改不动它。"""
    rows = [entry("c1", ["ds", "deepseek"], 0.5, "你写的说法。")]
    fresh = [CM.from_model({"key": ["deepseek", "ds"], "weight": 0.9, "content": "模型的说法。"}, 4)]
    got, touched = CM.merge(rows, fresh, CM.next_id)
    assert len(got) == 1 and got[0]["content"] == "你写的说法。", got
    assert touched == [], touched


def a_pending_one_is_not_carried():
    """模型提的常识在你确认之前不进上下文。"""
    rows = [dict(entry("c1", ["ds"], 0.9, "DS 是深度求索。"), pending=True)]
    assert CM.select(rows, "DS 给我写个代码") == [], "挂着的不该被选中"
    rows = [dict(rows[0], pending=False)]
    assert [e["id"] for e in CM.select(rows, "DS 给我写个代码")] == ["c1"]


def a_new_one_gets_the_next_id():
    rows = [entry("c1", ["a"], 0.5, "一。"), entry("c7", ["b"], 0.5, "二。")]
    got, touched = CM.merge(rows, [CM.from_model({"key": ["c"], "content": "三。"}, 1)], CM.next_id)
    assert [e["id"] for e in got] == ["c1", "c7", "c8"], got
    assert touched == ["c8"], touched


# ---------------------------------------------------------------- 端到端

import e2e                                                    # noqa: E402
from stdio import Sidecar                                     # noqa: E402

def with_sc(fn):
    """每个用例一个干净的数据目录：常识库是全局的，串了就看不出谁写的。"""
    def inner():
        with Sidecar(e2e.temp_dir()) as s:
            fn(s)
    return inner


def add(s, keys, weight, content):
    return s.ok("add-common", {"request_id": e2e.rid("cm"), "key": keys, "weight": weight, "content": content})


@with_sc
def the_page_can_add_edit_and_delete(s):
    added = add(s, ["ds", "deepseek"], 0.8, "deepseek 是深度求索旗下的大语言模型。")
    assert added["count"] == 1, added
    row = added["rows"][0]
    assert row["key"] == ["ds", "deepseek"] and row["weight"] == 0.8, row
    assert row["origin"] == "manual", row

    panel = s.ok("debug-common", {})
    assert panel["count"] == 1 and panel["limit"] == CM.LIMIT_DEFAULT, panel

    edited = s.ok("edit-common", {"request_id": e2e.rid("cm"), "common_id": row["id"],
                                  "weight": 0.3, "content": "改过的说法。"})
    got = edited["rows"][0]
    assert got["weight"] == 0.3 and got["content"] == "改过的说法。", got
    assert got["key"] == ["ds", "deepseek"], "没动的字段不该被清空"

    gone = s.ok("delete-common", {"request_id": e2e.rid("cm"), "common_id": row["id"]})
    assert gone["count"] == 0, gone
    err = s.fail("delete-common", {"request_id": e2e.rid("cm"), "common_id": row["id"]})
    assert err["code"] == "NOT_FOUND", err


@with_sc
def a_hit_puts_it_into_the_context(s):
    add(s, ["ds", "deepseek"], 0.8, "deepseek 是深度求索旗下的大语言模型。")
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev}, player_input="ds 这个模型怎么样",
                      ops=[{"op": "npc_action", "kind": "observe", "action": "她抬了下眼。", "significant": True}])
    s.ok("commit-turn", body)
    ctx = s.ok("get-context", {"session_id": sid, "depth": "brief", "cue": "ds 这个模型怎么样"})["context"]
    assert "common" in ctx, sorted(ctx)
    assert ctx["common"].startswith("### 常识"), ctx["common"]
    assert "deepseek 是深度求索旗下的大语言模型。" in ctx["common"], ctx["common"]


@with_sc
def a_line_that_does_not_mention_it_is_not_carried(s):
    add(s, ["ds"], 0.8, "DS 是深度求索。")
    sid, rev, _ = e2e.start(s)
    s.ok("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, player_input="今天下雨了",
                                   ops=[{"op": "npc_action", "kind": "observe", "action": "她看向窗外。", "significant": True}]))
    ctx = s.ok("get-context", {"session_id": sid, "depth": "brief", "cue": "今天下雨了"})["context"]
    assert "common" not in ctx, ctx.get("common")


@with_sc
def the_library_is_shared_across_sessions(s):
    """常识库是全局的：这一局学到的东西，下一局也记得。"""
    add(s, ["米饭"], 0.6, "他爱吃米饭。")
    one, _, _ = e2e.start(s)
    two, _, _ = e2e.start(s)
    assert one != two
    panel = s.ok("debug-common", {})
    assert panel["count"] == 1, panel
    ctx = s.ok("get-context", {"session_id": two, "depth": "brief", "cue": "晚上吃米饭吧"})["context"]
    assert "common" in ctx, "换一局照样查得到"
    assert "他爱吃米饭。" in ctx["common"], ctx["common"]


@with_sc
def what_she_learns_while_folding_goes_in(s):
    """总结 SCM 时顺手提到的常识，要落进这张全局表。"""
    sid, rev, _ = e2e.start(s)
    # 先聊满 20 条 ABM，引擎才认 memory_fold（不然就是「还没要收 ABM」）。
    for n in range(21):
        rev = s.ok("commit-turn", e2e.commit(
            {"session_id": sid, "revision": rev}, player_input="第 %d 句。" % n,
            ops=[{"op": "npc_action", "kind": "observe", "action": "她应了一声。", "significant": False}]))["revision"]
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "npc_action", "kind": "observe", "action": "她记下了。", "significant": False}],
                      memory_fold="这一段里他说过 DS 是深度求索的模型。",
                      common=[{"key": ["ds", "deepseek"], "weight": 0.7, "content": "deepseek 是深度求索旗下的大语言模型。"}])
    s.ok("commit-turn", body)
    panel = s.ok("debug-common", {})
    assert panel["count"] == 1, panel
    row = panel["rows"][0]
    assert row["key"] == ["ds", "deepseek"] and row["weight"] == 0.7, row
    assert row["origin"] in ("fold", "diary"), row
    # 模型提的先挂着：确认之前不注入，确认之后才注入
    assert row["pending"] is True and panel["pending"] == 1, panel
    ctx = s.ok("get-context", {"session_id": sid, "depth": "brief", "cue": "DS 是什么"})["context"]
    assert "common" not in ctx, ctx.get("common")
    approved = s.ok("approve-common", {"request_id": e2e.rid(), "common_id": row["id"]})
    assert approved["pending"] == 0 and approved["rows"][0]["pending"] is False, approved
    ctx = s.ok("get-context", {"session_id": sid, "depth": "brief", "cue": "DS 是什么"})["context"]
    assert "深度求索" in ctx.get("common", ""), ctx.get("common")


@with_sc
def a_plain_turn_cannot_write_the_global_library(s):
    """没总结、没写日记的那一回，随手带的 common 不算数。"""
    sid, rev, _ = e2e.start(s)
    body = e2e.commit({"session_id": sid, "revision": rev},
                      ops=[{"op": "npc_action", "kind": "observe", "action": "她没说什么。", "significant": True}],
                      common=[{"key": ["ds"], "weight": 0.9, "content": "不该被记下的一条。"}])
    s.ok("commit-turn", body)
    assert s.ok("debug-common", {})["count"] == 0, s.ok("debug-common", {})


@with_sc
def the_page_can_change_how_many_are_carried(s):
    for n in range(1, 5):
        add(s, ["ds%d" % n], 0.5, "第 %d 条。" % n)
    s.ok("set-common-limit", {"request_id": e2e.rid("cm"), "limit": 2})
    assert s.ok("debug-common", {})["limit"] == 2
    sid, rev, _ = e2e.start(s)
    s.ok("commit-turn", e2e.commit({"session_id": sid, "revision": rev}, player_input="ds1 ds2 ds3 ds4",
                                   ops=[{"op": "npc_action", "kind": "observe", "action": "她翻了一页。", "significant": True}]))
    ctx = s.ok("get-context", {"session_id": sid, "depth": "brief",
                               "cue": "ds1 ds2 ds3 ds4"})["context"]
    carried = [line for line in ctx["common"].split("\n") if line.startswith("- ")]
    assert len(carried) == 2, carried


check("a keyword only counts where it stands", a_keyword_only_counts_where_it_stands)
check("a chinese keyword matches inside a sentence", a_chinese_keyword_matches_inside_a_sentence)
check("nothing is hit without a cue", nothing_is_hit_without_a_cue)
check("the heavier one comes first", the_heavier_one_comes_first)
check("an equally heavy entry with more keywords wins", an_equally_heavy_entry_with_more_keywords_wins)
check("only a few are carried", only_a_few_are_carried)
check("the setting is clamped to the allowed range", the_setting_is_clamped_to_the_allowed_range)
check("what is carried looks like a short table", what_is_carried_looks_like_a_short_table)
check("nothing matched renders nothing", nothing_matched_renders_nothing)
check("what the model says is normalized", what_the_model_says_is_normalized)
check("a half written entry is ignored", a_half_written_entry_is_ignored)
check("the same keywords update instead of pile up", the_same_keywords_update_instead_of_pile_up)
check("the model cannot overwrite what you confirmed", the_model_cannot_overwrite_what_you_confirmed)
check("a pending one is not carried", a_pending_one_is_not_carried)
check("a new one gets the next id", a_new_one_gets_the_next_id)
check("the page can add, edit and delete", the_page_can_add_edit_and_delete)
check("a hit puts it into the context", a_hit_puts_it_into_the_context)
check("a line that does not mention it is not carried", a_line_that_does_not_mention_it_is_not_carried)
check("the library is shared across sessions", the_library_is_shared_across_sessions)
check("what she learns while folding goes in", what_she_learns_while_folding_goes_in)
check("a plain turn cannot write the global library", a_plain_turn_cannot_write_the_global_library)
check("the page can change how many are carried", the_page_can_change_how_many_are_carried)

run("common")
