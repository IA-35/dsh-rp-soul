"""Built-in responsibilities and lifecycle order; one process and transaction."""

from . import mood, memory, agency, wake

REGISTRY = {"mood": mood, "memory": memory, "agency": agency, "wake": wake}


def run(state, stage, *args, **kwargs):
    out = {}
    for name, module in REGISTRY.items():
        hook = getattr(module, stage, None)
        if hook is not None:
            out[name] = hook(state, *args, **kwargs)
    return out


def project(state, persona, cue="", full=False):
    out = {"context": {}, "companion": {}, "card": {}, "persona": {}}
    for result in run(state, "project", persona, cue, full).values():
        for target, fields in result.items():
            out[target].update(fields)
    return out
