# -*- coding: utf-8 -*-
"""Convert the Bishnitza inventory CSV into a FlipLedger v2 backup file.

Amounts in the sheet are euros; the app stores RON, so everything is
multiplied by RATE. Output is fed to the app's Data -> Restore.
"""
import csv, json, re, sys, time
from datetime import datetime

RATE = 5.25  # RON per EUR, matching flipledger.jsx

STATUS_MAP = {
    "Sold": "sold",
    "Donated": "writeoff",
    "Not Yet for sale": "holding",
    "In progress": "holding",
    "Bought": "holding",
}

def money(raw):
    """'€1.234,50' / '-€10.00' -> float euros. Blank, NaN, junk -> 0.0."""
    if raw is None:
        return 0.0
    s = str(raw).strip()
    if not s or s.lower() == "nan":
        return 0.0
    neg = s.startswith("-") or s.startswith("−")
    s = re.sub(r"[^0-9.,]", "", s)
    if not s:
        return 0.0
    # last separator is the decimal point
    dec = max(s.rfind(","), s.rfind("."))
    if dec > -1:
        intpart = re.sub(r"[.,]", "", s[:dec])
        frac = re.sub(r"[^0-9]", "", s[dec + 1:])
        s = f"{intpart}.{frac}" if frac else intpart
    try:
        v = float(s)
    except ValueError:
        return 0.0
    return -v if neg else v

def ron(eur):
    return round(eur * RATE, 2)

def date(raw):
    """DD/MM/YYYY -> YYYY-MM-DD; NaN/blank -> None."""
    if not raw:
        return None
    s = str(raw).strip()
    if not s or s.lower() == "nan":
        return None
    for f in ("%d/%m/%Y", "%Y-%m-%d", "%d.%m.%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, f).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None

def main(path, out):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))

    items, skipped, stats = [], 0, {}
    seen = set()
    stamp = int(time.time() * 1000)

    for n, r in enumerate(rows):
        name = (r.get("Product") or "").strip().replace("\n", " ")
        name = re.sub(r"\s+", " ", name)
        if not name:
            skipped += 1
            continue

        raw_status = (r.get("Status") or "").strip()
        status = STATUS_MAP.get(raw_status, "holding")
        stats[raw_status] = stats.get(raw_status, 0) + 1

        invested = money(r.get("Invested"))
        transport = money(r.get("Transport"))
        sell = money(r.get("Selling price"))

        pub = date(r.get("Publishing date"))
        sold_on = date(r.get("Selling date"))

        # unique, stable id derived from position
        iid = f"csv{stamp:x}{n:04d}"
        assert iid not in seen
        seen.add(iid)

        items.append({
            "id": iid,
            "code": "",
            "name": name[:200],
            "category": "Other",
            "lot": False,
            "parentId": None,
            "buy": ron(invested),
            "buyDate": pub or sold_on or None,
            "source": "Bishnitza import",
            "inShipping": ron(transport),
            "refurb": 0,
            "notes": "" if raw_status in STATUS_MAP else f"CSV status: {raw_status}",
            "status": status,
            "sell": ron(sell) if status != "holding" else "",
            "sellDate": (sold_on or pub) if status != "holding" else None,
            "channel": "",
            "shipping": 0,
            "packaging": 0,
            "fees": 0,
            "thumb": None,
            "photoCount": 0,
            # order by when the item was actually acquired, so the app's
            # "Newest" sort is meaningful; undated rows fall to the end
            # in sheet order rather than jumping to the top
            "created": (
                int(datetime.strptime(pub or sold_on, "%Y-%m-%d").timestamp() * 1000) + n
                if (pub or sold_on) else n
            ),
        })

    payload = {"app": "flipledger", "v": 2,
               "at": datetime.now().isoformat(), "items": items, "photos": {}}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)

    # report
    cost = sum(i["buy"] + i["inShipping"] for i in items)
    revenue = sum(float(i["sell"] or 0) for i in items)
    closed = [i for i in items if i["status"] != "holding"]
    print(f"items:            {len(items)}")
    print(f"skipped (blank):  {skipped}")
    print(f"status counts:    {stats}")
    print(f"total cost:       {cost:,.2f} RON  ({cost/RATE:,.2f} EUR)")
    print(f"total revenue:    {revenue:,.2f} RON  ({revenue/RATE:,.2f} EUR)")
    print(f"closed items:     {len(closed)}")
    print(f"realized profit:  {revenue - sum(i['buy']+i['inShipping'] for i in closed):,.2f} RON"
          f"  ({(revenue - sum(i['buy']+i['inShipping'] for i in closed))/RATE:,.2f} EUR)")
    print(f"\nwrote {out}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
