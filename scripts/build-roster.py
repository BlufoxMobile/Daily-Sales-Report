#!/usr/bin/env python3
"""
build-roster.py  -  Cook County Cooks / Big South - Chicago
-----------------------------------------------------------
Builds data/rep-roster.json: a map of each store -> the list of rep names
that currently appear in the daily Sales Report ("Rep Rank" sheet).

The quote sheets (Mobile 6th-Gen, Upgrade, Internet Rate Plan Calculator)
fetch this file so the "Rep Name" field is a dropdown of real, standardized
names instead of free text. New stores (e.g. Calumet City, Machesney Park)
flow in automatically as soon as they appear in the Sales Report / store
directory - no code changes needed.

Inputs  (already present in the repo at build time):
  - data/Sales Report.xlsx      (decoded from the Zapier upload by update.yml)
  - data/store-directory.json   (authoritative store list, if present)

Output:
  - data/rep-roster.json
"""

import json
import os
import glob
from datetime import datetime, timezone

import pandas as pd

# District owner whose stores we keep (matches scripts/build.py)
JEFF = "Jeffrey Bilbrey"
SUFFIX = " Xfinity Store"

DATA_DIR = "data"
DIRECTORY_PATH = os.path.join(DATA_DIR, "store-directory.json")
ROSTER_PATH = os.path.join(DATA_DIR, "rep-roster.json")


def find_excel():
    """Find the most recent sales report workbook in data/."""
    patterns = [
        "data/Sales Report.xlsx",
        "data/Blufox*Sales*Report*.xlsx",
        "data/Blufox*.xlsx",
        "data/*.xlsx",
    ]
    for pat in patterns:
        files = [f for f in glob.glob(pat) if "Order Status" not in f]
        if files:
            return max(files, key=os.path.getmtime)
    raise FileNotFoundError("No sales report .xlsx found in data/")


def short_to_full_map():
    """
    Build a short-location -> full-store-name map.
    Seeds from store-directory.json so we use the exact names the quote
    sheets already use (e.g. 'South Skokie' -> 'South Skokie Xfinity Store').
    """
    mapping = {}
    directory_stores = []
    if os.path.exists(DIRECTORY_PATH):
        try:
            with open(DIRECTORY_PATH) as f:
                directory = json.load(f)
            directory_stores = directory.get("stores", []) or []
            for full in directory_stores:
                short = full[: -len(SUFFIX)] if full.endswith(SUFFIX) else full
                mapping[short] = full
        except Exception as e:
            print(f"  (store-directory.json unreadable: {e})")
    return mapping, directory_stores


def jeff_short_stores(fp):
    """Short store names belonging to Jeff's district, from the Store Rank sheet."""
    df = pd.read_excel(fp, sheet_name="Store Rank", header=None).iloc[7:]
    df.columns = range(len(df.columns))
    return [str(s).strip() for s in df[df[4] == JEFF][2].dropna().tolist()]


def main():
    print("Cook County Cooks - Rep Roster Builder")
    fp = find_excel()
    print(f"  Using workbook: {fp}")

    mapping, directory_stores = short_to_full_map()

    # Union of every store we should expose: directory stores + Jeff's district
    # stores from the report (covers brand-new stores not yet in the directory).
    shorts = set(mapping.keys())
    try:
        for s in jeff_short_stores(fp):
            shorts.add(s)
            mapping.setdefault(s, s + SUFFIX)
    except Exception as e:
        print(f"  (could not read Store Rank for district stores: {e})")

    full_stores = sorted({mapping[s] for s in shorts})
    if directory_stores:
        # keep directory ordering/names where available, then any extras
        extras = [s for s in full_stores if s not in directory_stores]
        full_stores = list(directory_stores) + extras

    # Collect reps per store from the Rep Rank sheet.
    rr = pd.read_excel(fp, sheet_name="Rep Rank", header=None).iloc[5:]
    rr.columns = range(len(rr.columns))

    by_store = {full: [] for full in full_stores}
    seen = {full: set() for full in full_stores}

    for _, row in rr.iterrows():
        name = row[1]            # column B = Employee
        loc = row[3]             # column D = Location (short store name)
        if not isinstance(name, str):
            continue
        name = " ".join(name.split()).strip()
        if not name:
            continue
        loc = str(loc).strip()
        full = mapping.get(loc)
        if not full or full not in by_store:
            continue
        key = name.lower()
        if key in seen[full]:
            continue
        seen[full].add(key)
        by_store[full].append(name)

    for full in by_store:
        by_store[full].sort(key=lambda n: n.lower())

    roster = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "source": os.path.basename(fp) + " / Rep Rank",
        "byStore": by_store,
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ROSTER_PATH, "w") as f:
        json.dump(roster, f, indent=2, ensure_ascii=False)

    total = sum(len(v) for v in by_store.values())
    print(f"  Stores: {len(by_store)} | Reps: {total}")
    print(f"  Wrote: {ROSTER_PATH}")


if __name__ == "__main__":
    main()
