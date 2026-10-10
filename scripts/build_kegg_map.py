#!/usr/bin/env python3
"""Build web/db/kegg/ko-map.json — what the Function tab needs to name things.

The functional profiler reports KEGG ortholog identifiers and nothing else:
`ko:K01952, 0.0184`. That is unreadable, and it is only half a granularity — a
reader wants pathways and modules, not four-digit codes. This assembles the
naming and the two aggregations from KEGG's REST endpoints, trimmed to the KOs
the shipped reference actually contains so the file stays small.

    python3 scripts/build_kegg_map.py scripts/funprofiler/ko_full_k33.ndjson

LICENCE, WHICH IS NOT SETTLED. KEGG is copyrighted by Kanehisa Laboratories.
Academic use of the REST API is free; redistribution of KEGG-derived data is
restricted, and this writes a file into the repository. Two things make it
arguable rather than reckless — the file holds identifiers, names and membership
rather than sequence or annotation content, and fmh-funprofiler's own KEGG-derived
sketches are published on Zenodo under CC BY 4.0 by Penn State. It is still a
question for a human to answer before this ships. See docs/todo.md.
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "db" / "kegg" / "ko-map.json"
REST = "https://rest.kegg.jp"


def fetch(path):
    with urllib.request.urlopen(f"{REST}/{path}", timeout=120) as r:
        return r.read().decode()


def best_map(module, maps, ko_mod, path_ko):
    """The map that shows most of this module's orthologs, globals last."""
    kos = {k for k, ms in ko_mod.items() if module in ms}
    return sorted(maps, key=lambda m: (
        1 if m.startswith("map011") else 0, -len(path_ko.get(m, set()) & kos), m))[0]


def pairs(text):
    for line in text.splitlines():
        if not line.strip():
            continue
        a, _, b = line.partition("\t")
        yield a.split(":")[-1], b


def main():
    # Which KOs matter: the ones the reference can actually report. Everything
    # else is weight in a file the browser downloads.
    wanted = set()
    if len(sys.argv) > 1 and Path(sys.argv[1]).exists():
        for line in open(sys.argv[1]):
            if not line.strip():
                continue
            name = json.loads(line)[0].get("name", "")
            if name.startswith("ko:"):
                wanted.add(name[3:])
        print(f"reference holds {len(wanted)} KOs")
    else:
        print("no reference given — keeping every KO KEGG knows")

    ko_names = {}
    for k, v in pairs(fetch("list/ko")):
        if wanted and k not in wanted:
            continue
        # "ADH; alcohol dehydrogenase [EC:1.1.1.1]" -> the readable half
        name = v.split("; ", 1)[-1] if "; " in v else v
        ko_names[k] = name

    ko_mod = {}
    for k, v in pairs(fetch("link/module/ko")):
        if wanted and k not in wanted:
            continue
        ko_mod.setdefault(k, []).append(v.split(":")[-1])

    mod_names = {k: v for k, v in pairs(fetch("list/module"))}
    mod_path = {}
    for k, v in pairs(fetch("link/pathway/module")):
        mod_path.setdefault(k, []).append(v.split(":")[-1])
    path_names = {k: v for k, v in pairs(fetch("list/pathway"))}
    # Which orthologs each map holds — one request, used only to pick each
    # module's map below and never written to the file.
    path_ko = {}
    for p, k in pairs(fetch("link/ko/pathway")):
        if p.startswith("map"):
            path_ko.setdefault(p, set()).add(k.split(":")[-1])

    # Keep only modules a reported KO can reach, and only pathways those modules
    # reach: the rest can never appear on screen.
    used_mods = {m for ms in ko_mod.values() for m in ms}
    used_paths = {p for m in used_mods for p in mod_path.get(m, [])}

    doc = {
        "schema": "kegg-ko-map/1",
        "source": "KEGG REST (rest.kegg.jp), see scripts/build_kegg_map.py",
        "ko": ko_names,
        # DEDUPED, and this is not tidiness. KEGG's link/module/ko lists an
        # ortholog once per STEP it appears in, and several modules use the same
        # ortholog in two steps — K00918 is in two steps of M00001, hexokinase
        # and phosphofructokinase both being able to use it. Kept as-is, the
        # module's abundance counts that ortholog twice, and 39 modules of the
        # 508 here are inflated by it. Sorted so the file is reproducible.
        "koModules": {k: sorted(set(v)) for k, v in ko_mod.items()},
        "modules": {
            m: {"n": mod_names.get(m, m), "p": mod_path.get(m, []),
                # THE MAP TO SHOW A MODULE ON, decided here because the page
                # cannot decide it: choosing needs to know which orthologs each
                # map holds, and shipping that index would cost far more than
                # shipping the answer. By coverage, not by KEGG's order —
                # M00074 has three of its eleven orthologs on the first map it
                # lists and ten on another, and fourteen modules of 508 differ.
                # Global 011xx maps rank last whatever their coverage: a
                # ten-ortholog module is a speck on the whole of metabolism.
                **({"b": best_map(m, mod_path.get(m, []), ko_mod, path_ko)}
                   if mod_path.get(m) else {})}
            for m in sorted(used_mods)
        },
        "pathways": {p: path_names.get(p, p) for p in sorted(used_paths)},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    size = OUT.stat().st_size
    in_mod = len(doc["koModules"])
    print(
        f"{len(ko_names)} KO names, {in_mod} of them in a module "
        f"({in_mod / max(1, len(ko_names)):.0%}), {len(used_mods)} modules, "
        f"{len(used_paths)} pathways -> {OUT.relative_to(ROOT)} ({size / 1e6:.2f} MB)"
    )


if __name__ == "__main__":
    main()
