"""A tiny assertion harness: no pytest, no deps, exit code 1 on failure.

Every P1 test module ends with ``run()`` which prints one line per case so a
failure names the behaviour that broke, not a traceback line number.
"""

import sys
import traceback

PASSED = []
FAILED = []


def check(name, fn):
    try:
        fn()
    except AssertionError as exc:
        FAILED.append((name, "assert: %s" % (exc or "")))
    except Exception:
        FAILED.append((name, traceback.format_exc(limit=3)))
    else:
        PASSED.append(name)
    return fn


def raises(fn, needle, code=None):
    """Assert that fn() raises a dict-shaped failure carrying `needle`."""
    def inner():
        try:
            fn()
        except Exception as exc:
            text = str(exc)
            assert needle in text, "expected %r in %r" % (needle, text[:300])
            if code is not None:
                assert code in text, "expected code %r in %r" % (code, text[:300])
            return
        raise AssertionError("expected a failure containing %r, got none" % needle)
    return inner


def run(title):
    total = len(PASSED) + len(FAILED)
    for name, reason in FAILED:
        print("FAIL %s\n     %s" % (name, reason))
    print("\n%s: %d/%d passed" % (title, len(PASSED), total))
    sys.exit(1 if FAILED else 0)
