#!/usr/bin/env python3
"""Check the data files before committing. Standard library only.

    python3 scripts/validate.py

Exits non-zero if something is wrong; warnings don't fail the check.
"""
import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
TYPES = {"underground", "multi-storey"}
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

errors, warnings = [], []


def point_in_polygon(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


boundary = json.loads((DATA / "boundary.geojson").read_text(encoding="utf-8"))
ring = boundary["features"][0]["geometry"]["coordinates"][0]

parkings = json.loads((DATA / "parkings.json").read_text(encoding="utf-8"))
by_id = {}
for i, p in enumerate(parkings):
    where = f"parkings.json[{i}] ({p.get('id', '?')})"
    for key in ("id", "name", "type", "lat", "lon"):
        if p.get(key) in (None, ""):
            errors.append(f"{where}: missing '{key}'")
    pid = p.get("id", "")
    if pid and not ID_RE.match(pid):
        errors.append(f"{where}: id must be lowercase-with-dashes")
    if pid in by_id:
        errors.append(f"{where}: duplicate id")
    by_id[pid] = p
    if p.get("type") and p["type"] not in TYPES:
        errors.append(f"{where}: type must be one of {sorted(TYPES)}")
    cap = p.get("capacity")
    if cap is not None and (not isinstance(cap, int) or cap <= 0):
        errors.append(f"{where}: capacity must be a positive integer or null")
    if isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lon"), (int, float)):
        if not point_in_polygon(p["lon"], p["lat"], ring):
            warnings.append(f"{where}: lies outside the railway-loop boundary")

with open(DATA / "observations.csv", newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    expected = ["parking_id", "date", "time", "parked", "note"]
    if reader.fieldnames != expected:
        errors.append(f"observations.csv: header must be {','.join(expected)}")
    seen = set()
    for n, row in enumerate(reader, start=2):
        where = f"observations.csv line {n}"
        pid = row.get("parking_id", "")
        if pid not in by_id:
            errors.append(f"{where}: unknown parking_id '{pid}'")
        try:
            date.fromisoformat(row.get("date", ""))
        except ValueError:
            errors.append(f"{where}: date must be YYYY-MM-DD")
        t = row.get("time", "")
        if t and not TIME_RE.match(t):
            errors.append(f"{where}: time must be HH:MM (24h) or empty")
        try:
            parked = int(row.get("parked", ""))
            if parked < 0:
                raise ValueError
        except ValueError:
            errors.append(f"{where}: parked must be a whole number >= 0")
            continue
        cap = by_id.get(pid, {}).get("capacity")
        if cap and parked > cap:
            warnings.append(f"{where}: {parked} parked exceeds capacity {cap}")
        key = (pid, row.get("date"), t)
        if key in seen:
            warnings.append(f"{where}: duplicate observation for {pid} {row.get('date')} {t}")
        seen.add(key)

for w in warnings:
    print("warning:", w)
for e in errors:
    print("error:", e)
print(f"{len(parkings)} parkings checked, {len(errors)} errors, {len(warnings)} warnings")
sys.exit(1 if errors else 0)
