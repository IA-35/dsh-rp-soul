"""常识库：模型交账时顺手提的常识，一律挂起等主人在设置页确认（见 domain/common.py）。"""

from ..domain import common as CM


def pay_requests(state, commit, turn):
    """这一回合里提到的常识。随时都能提；pending 的那道闸在设置页，不在这里。"""
    found = []
    for raw in commit.get("common") or ():
        item = CM.from_model(raw, turn, origin="turn")
        if item is not None:
            found.append(item)
    return {"common": found}
