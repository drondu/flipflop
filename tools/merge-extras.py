# -*- coding: utf-8 -*-
"""Fold hand-entered items from an app backup into the CSV import file.

Use when the CSV import has to be loaded with Replace (because item ids
changed) but the ledger also holds items typed straight into the app.
Anything in the backup whose id is not a csvrow* id is carried over.
"""
import json, io, sys

def main(backup_path, import_path, out_path):
    backup = json.load(io.open(backup_path, encoding="utf-8"))
    imported = json.load(io.open(import_path, encoding="utf-8"))

    csv_ids = {i["id"] for i in imported["items"]}
    extras, photos = [], dict(imported.get("photos") or {})

    for it in backup.get("items", []):
        if it["id"].startswith("csvrow") or it["id"] in csv_ids:
            continue          # a previous import, superseded by this file
        if it["id"].startswith("csv"):
            continue          # an older timestamped import id
        extras.append(it)
        p = (backup.get("photos") or {}).get(it["id"])
        if p:
            photos[it["id"]] = p

    merged = dict(imported)
    merged["items"] = extras + imported["items"]
    merged["photos"] = photos
    json.dump(merged, io.open(out_path, "w", encoding="utf-8"), ensure_ascii=False)

    print(f"carried over {len(extras)} hand-entered item(s):")
    for e in extras:
        print(f"   {e.get('name','(unnamed)')[:50]}")
    print(f"imported rows: {len(imported['items'])}")
    print(f"total written: {len(merged['items'])} -> {out_path}")

if __name__ == "__main__":
    main(*sys.argv[1:4])
