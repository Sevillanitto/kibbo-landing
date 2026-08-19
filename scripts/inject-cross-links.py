#!/usr/bin/env python3
"""
inject-cross-links.py — deterministic cross-link injector for Kibbo articles.

Reads cross-link-map.json (project root) and, for every *.html file in a given
folder, replaces the "Related Kibbo Tools" placeholder comment with real <a>
links, looked up from a <!-- CROSSLINK_TAGS: tag1, tag2 --> marker in the file.

No AI/LLM calls. Pure deterministic string/regex processing against the JSON
data file — if a tag isn't in the map, the script reports it and skips it
rather than guessing a link.

Usage:
    python scripts/inject-cross-links.py <folder> <block> [--dry-run]

    <folder>    Path to a folder of .html files to process (non-recursive).
                e.g. _drafts-pending/usa-housing
    <block>     The block key in cross-link-map.json, e.g. housing-rentals
                Required explicitly — never auto-detected/guessed from the
                folder name, to keep this deterministic.
    --dry-run   Report what would be injected without writing any files.

Expected article markers (already used in Kibbo draft articles):
    <!-- CROSSLINK_TAGS: deposit-dispute, habitability -->
        One line, anywhere in the file. Comma-separated tag list.
    <!-- Claude Code: link ... here once URLs confirmed live -->
        The placeholder to replace, immediately inside the "Related Kibbo
        Tools" section. Any text between "Claude Code:" and "-->" is
        accepted and discarded — the script does not parse it, it only
        uses CROSSLINK_TAGS to decide what to inject.

Output pattern (matches the live site's existing Related Kibbo Tools blocks
exactly):
    <ul>
    <li><a href="/templates/some-template.html">Some Template →</a></li>
    </ul>
"""

import argparse
import html
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MAP_FILE = PROJECT_ROOT / "cross-link-map.json"
SITE_ORIGIN = "https://www.getkibbo.com"

CROSSLINK_TAGS_RE = re.compile(
    r"<!--\s*CROSSLINK_TAGS:\s*(?P<tags>[^>]*?)\s*-->", re.IGNORECASE
)
PLACEHOLDER_RE = re.compile(
    r"<!--\s*Claude Code:.*?-->", re.IGNORECASE | re.DOTALL
)


def load_cross_link_map():
    if not MAP_FILE.exists():
        sys.exit(f"ERROR: {MAP_FILE} not found. Run this script from a checkout "
                  f"that has cross-link-map.json at the project root.")
    with open(MAP_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def url_to_relative(url):
    """Convert a full getkibbo.com URL to the site-relative path used in
    on-page hrefs (e.g. https://www.getkibbo.com/templates/x.html -> /templates/x.html).
    Leaves non-getkibbo.com URLs untouched (defensive, not currently used)."""
    if url.startswith(SITE_ORIGIN):
        return url[len(SITE_ORIGIN):]
    return url


def build_link_html(entries):
    """Build the <ul>...</ul> block for a list of {type, name, url} entries,
    matching the exact pattern already used site-wide."""
    lines = ["<ul>"]
    for entry in entries:
        href = url_to_relative(entry["url"])
        name = html.escape(entry["name"], quote=False)
        lines.append(f'<li><a href="{href}">{name} →</a></li>')
    lines.append("</ul>")
    return "\n".join(lines)


def process_file(path, block_tags, dry_run):
    """Returns a report dict for this file. Does not raise on expected
    'nothing to do' conditions — those are reported, not errors."""
    report = {
        "file": path.name,
        "status": None,          # "injected" | "skipped_no_tags" | "skipped_no_placeholder" | "skipped_unresolved"
        "tags_found": [],
        "matched_tags": [],
        "unmatched_tags": [],
        "links_injected": [],
    }

    # newline="" on both read and write: no newline translation at all, so the
    # file's original line-ending convention (LF, matching the rest of this
    # repo) is preserved exactly rather than being rewritten to the platform
    # default (CRLF on Windows) when we write the modified content back.
    text = path.read_text(encoding="utf-8", newline="")

    tags_match = CROSSLINK_TAGS_RE.search(text)
    if not tags_match:
        report["status"] = "skipped_no_tags"
        return report

    tags = [t.strip() for t in tags_match.group("tags").split(",") if t.strip()]
    report["tags_found"] = tags

    # Look up each tag; collect matched entries (deduped by URL, order preserved),
    # and any tag with no entry in the map — reported, never guessed.
    seen_urls = set()
    entries = []
    for tag in tags:
        if tag in block_tags:
            report["matched_tags"].append(tag)
            for entry in block_tags[tag]:
                if entry["url"] not in seen_urls:
                    seen_urls.add(entry["url"])
                    entries.append(entry)
        else:
            report["unmatched_tags"].append(tag)

    if not entries:
        # Every tag was unmatched (or the tag list was empty after stripping) —
        # nothing to inject. Report and leave the file untouched.
        report["status"] = "skipped_unresolved"
        return report

    placeholder_match = PLACEHOLDER_RE.search(text)
    if not placeholder_match:
        report["status"] = "skipped_no_placeholder"
        return report

    link_html = build_link_html(entries)
    new_text = text[:placeholder_match.start()] + link_html + text[placeholder_match.end():]

    report["links_injected"] = [e["name"] for e in entries]
    report["status"] = "injected"

    if not dry_run:
        path.write_text(new_text, encoding="utf-8", newline="")

    return report


def print_report(report):
    print(f"\n--- {report['file']} ---")
    if report["status"] == "skipped_no_tags":
        print("  No <!-- CROSSLINK_TAGS: ... --> marker found — skipped.")
        return
    print(f"  Tags found: {', '.join(report['tags_found']) or '(none)'}")
    if report["matched_tags"]:
        print(f"  Matched tags: {', '.join(report['matched_tags'])}")
    if report["unmatched_tags"]:
        print(f"  UNMATCHED tags (no entry in cross-link-map.json — not guessed): "
              f"{', '.join(report['unmatched_tags'])}")
    if report["status"] == "skipped_unresolved":
        print("  No tags resolved to any link — nothing injected.")
    elif report["status"] == "skipped_no_placeholder":
        print("  Tags resolved, but no '<!-- Claude Code: link ... -->' placeholder "
              "found in this file — nothing injected. Add the placeholder inside "
              "the Related Kibbo Tools section and re-run.")
    elif report["status"] == "injected":
        print(f"  Links injected ({len(report['links_injected'])}):")
        for name in report["links_injected"]:
            print(f"    - {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", help="Folder of .html files to process (non-recursive).")
    parser.add_argument("block", help="Block key in cross-link-map.json, e.g. housing-rentals")
    parser.add_argument("--dry-run", action="store_true", help="Report only, write no files.")
    args = parser.parse_args()

    folder = Path(args.folder)
    if not folder.is_dir():
        sys.exit(f"ERROR: {folder} is not a folder.")

    data = load_cross_link_map()
    blocks = data.get("blocks", {})
    if args.block not in blocks:
        available = ", ".join(blocks.keys())
        sys.exit(f"ERROR: block '{args.block}' not found in cross-link-map.json. "
                  f"Available blocks: {available}")

    block_tags = blocks[args.block].get("tags", {})
    if not block_tags:
        print(f"WARNING: block '{args.block}' has no tags defined in "
              f"cross-link-map.json yet (empty). Every file will report "
              f"unmatched/unresolved tags — this is expected if the block's "
              f"tools aren't live yet.")

    html_files = sorted(folder.glob("*.html"))
    if not html_files:
        sys.exit(f"ERROR: no .html files found directly in {folder}")

    print(f"Processing {len(html_files)} file(s) in {folder} against block "
          f"'{args.block}'{' (DRY RUN — no files will be written)' if args.dry_run else ''}...")

    reports = [process_file(f, block_tags, args.dry_run) for f in html_files]
    for r in reports:
        print_report(r)

    injected = sum(1 for r in reports if r["status"] == "injected")
    no_tags = sum(1 for r in reports if r["status"] == "skipped_no_tags")
    no_placeholder = sum(1 for r in reports if r["status"] == "skipped_no_placeholder")
    unresolved = sum(1 for r in reports if r["status"] == "skipped_unresolved")
    total_links = sum(len(r["links_injected"]) for r in reports)
    all_unmatched = sorted({t for r in reports for t in r["unmatched_tags"]})

    print("\n=== SUMMARY ===")
    print(f"Files processed:        {len(reports)}")
    print(f"Files with links injected: {injected} ({total_links} links total)")
    print(f"Files with no CROSSLINK_TAGS marker: {no_tags}")
    print(f"Files with tags but no placeholder:  {no_placeholder}")
    print(f"Files with tags but none resolved:   {unresolved}")
    if all_unmatched:
        print(f"Unmatched tags across all files (add these to cross-link-map.json "
              f"if they should exist): {', '.join(all_unmatched)}")
    if args.dry_run:
        print("\nDRY RUN — no files were modified.")


if __name__ == "__main__":
    main()
