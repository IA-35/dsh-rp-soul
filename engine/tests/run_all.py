"""Run every engine test file in one go: python tests/run_all.py"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = sorted(name for name in os.listdir(HERE) if name.startswith("test_") and name.endswith(".py"))


def main():
    failed = []
    for name in FILES:
        print("\n=== %s ===" % name)
        result = subprocess.run([sys.executable, os.path.join(HERE, name)], cwd=os.path.dirname(HERE),
                                env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"))
        if result.returncode != 0:
            failed.append(name)
    print("\n%d/%d files passed" % (len(FILES) - len(failed), len(FILES)))
    if failed:
        print("failed: %s" % ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
