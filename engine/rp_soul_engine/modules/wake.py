"""Wake plans are ledger data; actual timers and delivery belong to DSH."""

from ..domain import clock as CL, ops as OPS


def project(state, persona, cue, full):
    plan = OPS.current_plan(state)
    if plan is None:
        return {}
    return {"companion": {"plan": {"note": plan["note"], "until": dict(plan["until"]),
                                    "until_label": CL.label(plan["until"])}}}
