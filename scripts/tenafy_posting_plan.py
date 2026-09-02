#!/usr/bin/env python3
"""
Fetch today's Tenafy advertising plan and turn it into concrete posting instructions.

    python3 tenafy_posting_plan.py                 # today (Hong Kong)
    python3 tenafy_posting_plan.py 2026-08-13      # a specific day
    python3 tenafy_posting_plan.py --json          # machine-readable, for browser control
    python3 tenafy_posting_plan.py --check-photos  # also verify the photo folders exist

Setup (once):

    export TENAFY_API_KEY='pk_...'                 # a READ-ONLY key is sufficient
    export TENAFY_PHOTO_ROOT='/mnt/d/Tane/photos'  # where your unit photo folders live

The API key must never be hard-coded in this file. A read-only key is enough: nothing
in the plan depends on writing anything back.

Stdlib only — no pip install required.
"""

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

BASE_URL = os.environ.get("TENAFY_BASE_URL", "https://platform.tenafy.com")
API_KEY = os.environ.get("TENAFY_API_KEY", "")
PHOTO_ROOT = os.environ.get("TENAFY_PHOTO_ROOT", "")
TIMEOUT_SECONDS = 30

TIER_NAMES = {1: "VACANT", 2: "NR", 3: "MR/other"}


def fetch_plan(date: str | None) -> dict:
    """GET the posting plan. Raises SystemExit with a readable message on failure."""
    if not API_KEY:
        sys.exit("TENAFY_API_KEY is not set. export it first (a read-only key is fine).")

    query = urllib.parse.urlencode({"date": date}) if date else ""
    url = f"{BASE_URL}/api/public/posting-plan" + (f"?{query}" if query else "")
    request = urllib.request.Request(url, headers={"X-API-Key": API_KEY})

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS,
                                    context=ssl.create_default_context()) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        # 401/403 = key problem; 400 = bad date. Say which, rather than a bare traceback.
        sys.exit(f"API returned HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        sys.exit(f"Could not reach {BASE_URL}: {exc.reason}")

    if payload.get("code") != 200:
        sys.exit(f"API error: {payload.get('message', payload)}")
    return payload.get("data") or {}


def photo_dir(image_hint: str) -> Path | None:
    """Local folder for a post. image_hint is 'Property/Unit' relative to PHOTO_ROOT."""
    if not PHOTO_ROOT or not image_hint:
        return None
    return Path(PHOTO_ROOT).expanduser() / image_hint


def photos_in(directory: Path | None) -> list[Path]:
    if directory is None or not directory.is_dir():
        return []
    suffixes = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
    return sorted(p for p in directory.iterdir()
                  if p.is_file() and p.suffix.lower() in suffixes)


def build_instructions(plan: dict, check_photos: bool) -> list[dict]:
    """One instruction per ready post, in the order the schedule lists them."""
    instructions = []
    for post in plan.get("posts") or []:
        if post.get("status") != "ready":
            continue
        forum = post.get("forum") or {}
        account = post.get("account") or {}
        # A bundle can span several units (e.g. "Gilman 4B/5B"), so collect a folder
        # per unit rather than assuming one.
        folders = []
        for hint in post.get("image_hint") or []:
            directory = photo_dir(hint)
            entry = {"image_hint": hint, "folder": str(directory) if directory else None}
            if check_photos:
                files = photos_in(directory)
                entry["exists"] = directory is not None and directory.is_dir()
                entry["photo_count"] = len(files)
                entry["photos"] = [str(p) for p in files]
            folders.append(entry)

        instructions.append({
            "slot": post.get("slot_label"),
            "position": post.get("position"),
            "tier": post.get("tier"),
            "tier_name": TIER_NAMES.get(post.get("tier"), "?"),
            "intent": post.get("intent"),
            "extra": bool(post.get("extra")),
            "property": post.get("property_name"),
            "units": post.get("unit_names") or [],
            "group_name": forum.get("forum_name"),
            "group_url": forum.get("url"),
            "post_as": account.get("email") or account.get("name"),
            "owned_group": bool(forum.get("is_owned")),
            "post_text": post.get("post_text") or "",
            "photo_folders": folders,
        })
    return instructions


def print_human(plan: dict, instructions: list[dict], check_photos: bool) -> None:
    date = plan.get("date")
    print(f"Tenafy posting plan — {date} ({plan.get('day_name')})")
    print(f"slots scheduled: {plan.get('slot_count')}   ready posts: {len(instructions)}"
          f"   extras: {plan.get('extra_count', 0)}")
    tiers = plan.get("tier_counts") or {}
    print(f"tiers — vacant {tiers.get('vacant', 0)} · NR {tiers.get('nr', 0)} "
          f"· MR/other {tiers.get('other', 0)}")
    print(f"rules — min gap {plan.get('min_gap_days')}d · NR lead {plan.get('lead_days_nr')}d "
          f"· other lead {plan.get('lead_days_other')}d")

    if not instructions:
        print("\nNothing ready to post.")
        _explain_empty(plan)
        return

    # Group by account: you log in once per account, so post everything for that
    # account before switching.
    by_account = defaultdict(list)
    for item in instructions:
        by_account[item["post_as"] or "(no account)"].append(item)

    for account, items in by_account.items():
        print(f"\n{'=' * 72}\nLOG IN AS: {account}   ({len(items)} post(s))\n{'=' * 72}")
        for item in items:
            units = ", ".join(item["units"]) or "—"
            flags = []
            if item["extra"]:
                flags.append("EXTRA")
            if item["owned_group"]:
                flags.append("own group")
            suffix = f"  [{' · '.join(flags)}]" if flags else ""
            print(f"\n  {item['slot']} — {item['property']} ({units})"
                  f"  ·  {item['tier_name']}{suffix}")
            print(f"  GROUP: {item['group_name']}")
            print(f"     {item['group_url']}")
            for folder in item["photo_folders"]:
                line = f"  PHOTOS: {folder['folder'] or '(TENAFY_PHOTO_ROOT not set)'}"
                if check_photos:
                    if not folder.get("exists"):
                        line += "   *** FOLDER MISSING ***"
                    elif folder.get("photo_count") == 0:
                        line += "   *** NO IMAGES ***"
                    else:
                        line += f"   ({folder['photo_count']} images)"
                print(line)
            print("  ---- text ----")
            for text_line in (item["post_text"] or "").splitlines() or ["(no text)"]:
                print(f"  | {text_line}")

    if check_photos:
        broken = [f"{i['slot']} {f['image_hint']}"
                  for i in instructions for f in i["photo_folders"]
                  if not f.get("exists") or f.get("photo_count") == 0]
        if broken:
            print(f"\n{len(broken)} post(s) have no usable photos: {', '.join(broken)}")


def _explain_empty(plan: dict) -> None:
    """An empty plan has several distinct causes — name the likely one."""
    if not plan.get("slot_count"):
        print("  No slots are scheduled for this weekday. Either the schedule has not "
              "been seeded, or this day genuinely has no rows.")
        return
    no_slot = [p for p in plan.get("posts") or [] if p.get("status") == "no_slot"]
    needs_template = [p for p in plan.get("posts") or []
                      if p.get("status") == "needs_template"]
    if no_slot:
        print(f"  {len(no_slot)} property/properties had no slot left today "
              f"(more advertisable units than scheduled rows).")
    if needs_template:
        print(f"  {len(needs_template)} property/properties have no advertising template "
              f"assigned, so nothing could be rendered.")
    # Held back rather than posted: a unit in the bundle is handed to a new tenant
    # the day the current lease ends, so it has no availability date to advertise.
    # Worth printing loudly — it means the vacancy feed and the leases disagree.
    already_let = [p for p in plan.get("posts") or [] if p.get("status") == "already_let"]
    if already_let:
        print(f"  {len(already_let)} post(s) were HELD BACK because a unit is already re-let:")
        for post in already_let:
            print(f"    {post.get('property_name')}: {post.get('reason')}")
    unfilled = plan.get("unfilled_slots") or []
    if unfilled and not no_slot:
        print(f"  {len(unfilled)} slot(s) had nothing to advertise — check whether the "
              f"40-day gap rule or the NR/MR lead windows are excluding units.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch the Tenafy advertising posting plan.")
    parser.add_argument("date", nargs="?", help="YYYY-MM-DD (default: today, Hong Kong)")
    parser.add_argument("--json", action="store_true",
                        help="emit JSON for a browser-control step to consume")
    parser.add_argument("--check-photos", action="store_true",
                        help="verify each photo folder exists and list its images")
    args = parser.parse_args()

    plan = fetch_plan(args.date)
    instructions = build_instructions(plan, args.check_photos)

    if args.json:
        json.dump({
            "date": plan.get("date"),
            "day_name": plan.get("day_name"),
            "slot_count": plan.get("slot_count"),
            "tier_counts": plan.get("tier_counts"),
            "photo_root": PHOTO_ROOT or None,
            "instructions": instructions,
        }, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        print_human(plan, instructions, args.check_photos)


if __name__ == "__main__":
    main()
