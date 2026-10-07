#!/usr/bin/env python3
"""Offline Python/JS syntax and local Markdown link-target check (not browser paint/TypeScript)."""
import ast
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


def main():
    root = Path(__file__).resolve().parent.parent
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    counts = {"python": 0, "javascript": 0, "links": 0}
    failures = []
    for name in filter(None, names):
        file = root / name
        if file.suffix == ".py":
            try:
                ast.parse(file.read_text(), filename=name)
                counts["python"] += 1
            except SyntaxError:
                failures.append(name + ": Python syntax")
        elif file.suffix in {".js", ".mjs"}:
            result = subprocess.run(["node", "--check", str(file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode:
                failures.append(name + ": JavaScript syntax")
            counts["javascript"] += 1
        elif file.suffix == ".md":
            # Exclude fenced examples; anchors are not path targets.
            text = re.sub(r"```[^\n]*\n[\s\S]*?```", "", file.read_text())
            for target in re.findall(r"\]\(([^\s)]+)\)", text):
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                counts["links"] += 1
                destination = (file.parent / unquote(parsed.path)).resolve()
                if not destination.is_relative_to(root) or not destination.exists():
                    failures.append(name + ": missing/escaping local link")
    if failures:
        print("\n".join(failures))
        return 1
    print("PASS: " + "; ".join(f"{number} {kind}" for kind, number in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
