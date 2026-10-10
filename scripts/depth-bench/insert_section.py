#!/usr/bin/env python3
"""Put §3.3 into the note, replacing any copy already there.

    python3 scripts/depth-bench/insert_section.py

The section is generated from the measurements (`section.py`), so re-running the
experiment and re-running this is the whole update path — there is no version of
the numbers that lives only in the prose.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PAPER = os.path.join(ROOT, "docs/paper/peekmicrobiome-application-note.md")
HEAD = "### 3.3 What a peek recovers: read depth, and three references"
# The section ends at the next heading of its level or above, NOT at §4: §3.4
# follows it, and replacing everything up to §4 deleted §3.4 on every re-run.
FOLLOWERS = ("### 3.4", "## 4 Use case")

section = subprocess.run([sys.executable, os.path.join(ROOT, "scripts/depth-bench/section.py")],
                         capture_output=True, text=True)
if section.returncode:
    sys.exit(section.stderr.strip() or "section.py a échoué")
body = section.stdout.rstrip() + "\n"

with open(PAPER, encoding="utf-8") as fh:
    paper = fh.read()


def next_heading(text, at):
    """Where the first `## ` or `### ` heading after `at` begins."""
    hits = [i + 1 for i in (text.find("\n## ", at), text.find("\n### ", at)) if i >= 0]
    return min(hits) if hits else len(text)


if HEAD in paper:
    start = paper.index(HEAD)
    end = next_heading(paper, start + len(HEAD))
    paper = paper[:start] + body + "\n" + paper[end:]
    what = "remplacée"
else:
    anchors = [paper.index(f) for f in FOLLOWERS if f in paper]
    if not anchors:
        sys.exit(f"repère introuvable dans la note : {FOLLOWERS!r}")
    end = min(anchors)
    paper = paper[:end] + body + "\n" + paper[end:]
    what = "insérée"

with open(PAPER, "w", encoding="utf-8") as fh:
    fh.write(paper)
print(f"§3.3 {what} ({len(body.splitlines())} lignes)")
