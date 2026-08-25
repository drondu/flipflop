# -*- coding: utf-8 -*-
"""Assign FlipLedger categories from product names (Romanian/German/English).

Ordered rules, first match wins. The ordering carries real meaning:
  - consoles before Full PC, or "ps5" reads as a PC
  - Cooler before CPU/Motherboard, so "cpu cooler" and "am4 cooler" are
    coolers rather than the chip or board they attach to
  - whole systems before components, so "calculator rtx 2070" is a PC
  - a lot of loose parts ("2x mb + 2x i7") is a Bundle, but a machine
    sold with a screen ("pc 3d + monitor") is still a Full PC
Patterns avoid \b next to non-ASCII and German compounds, where a word
boundary never appears mid-word.
"""
import re

RULES = [
    # consoles first: "ps5" would otherwise be caught as a PC
    ("Console", r"\bps5\b|playstation|xbox|nintendo"),

    # loose multi-part lots, before any single component can claim them
    ("Bundle",  r"\bbundle\b|compononente|\bpiese\b|\brandom\b|diverse|chestii|"
                r"cumparaturi|\btemu\b|aliexpress|karton|umzug|altele|\b2x\b"),

    # whole systems, before the components named inside them
    ("Full PC", r"calculator|\bpc\b"),
    ("Laptop",  r"laptop|macbook|thinkpad|notebook"),

    # cooling before CPU/Motherboard: "cpu cooler", "am4 cooler"
    # garment steamer, before Furniture matches inside the compound
    ("Appliances", r"dampfgl[äa]tter|dampfb[üu]rste"),
    ("Cooler",  r"cooler|ventilat(or|oare)|\bfans?\b|noctua|\baio\b|alp[fh]?en|l[üu]fter"),

    ("Case",    r"carcasa|caracasa|\bcase\b|geh[äa]use|fractal|sharkoon|chieftec|silentmax|azza|\btuf\b"),
    ("PSU",     r"surs[ăa]|\bsursa\b|\bpsu\b|netzteil|\b\d{3,4}\s*w\b"),
    ("Motherboard", r"placa baza|plac[ăa] baz[ăa]|main?board|maiboard|motherboard|\bmb\b|aorus|\bx99\b|\b1151\b|\bam4\b"),
    ("GPU",     r"\b(gtx|rtx|rx)\s*\d|gtx\d|grafikkarte|\bgpu\b|\b10[78]0\b|6800xt"),
    ("CPU",     r"\bi[3579][\s-]*\d{4,5}|ryzen|\bcpu\b|\bi[3579]\b"),
    ("RAM",     r"\d{1,3}\s*gb.*(ram|ddr|tforce|ripjaws|gskill|corsair pro)|\bram\b|\bddr[345]\b"),
    ("Storage", r"\bssd\b|\bhdd\b|nvme|m\.2|\d+\s*tb\b|festplatte"),
    ("Monitor", r"monitor|\bag\s*\d{3}|alienware"),

    # TV stands and benches are furniture, not televisions
    ("Furniture", r"fernsehtisch|tv[- ]?st[äa]nder|tv-?tisch"),
    ("Peripherals", r"\bvr\b|tastatur|mouse|casti|kopfh[öo]rer|headset|microfon|mikrofon|keyboard|corsair hub"),
    ("TV",      r"\btv\b|fernseher|\bzoll\b|\binch\b|oled|qled|bravia|fernsehtisch"),
    ("Optical drive", r"blue?ray|blu-ray"),
    ("Networking", r"cat\s*[57]e?\b|ethernet|netzwerkkabel|wlan|mesh|hdmi|kabel|d-link"),

    ("Furniture", r"sofa|stuhl|st[üu]hle|schrank|kallax|\bpax\b|ikea|tisch|regal|barhocker|"
                  r"scaun|\bmasa\b|birou|schaukel|m[öo]bel|hocker|st[äa]nder|puzzle mat|kommode|matratze"),
    ("Appliances", r"thermomix|nespresso|kapselmaschine|airfryer|air fryer|grill|raclette|"
                   r"b[üu]gler|dampf|pfanne|soda\s*stream|laufband|kitchenaid|cleanmaxx|silvercrest|"
                   r"staubsauger|mixer|toaster"),
    ("Lighting", r"lustra|lampe|\blamp\b|leuchte|licht"),
    ("Wearables", r"\bwatch\b|\buhr\b|kindle|smartwatch"),
    ("Kitchenware", r"gl[äa]ser|teekocher|\bcana\b|geschirr|becher|tasse"),
    ("Bikes", r"bicicleta|fahrrad|\bbike\b"),
]

COMPILED = [(c, re.compile(p, re.I)) for c, p in RULES]


def categorize(name):
    n = (name or "").lower()
    for cat, rx in COMPILED:
        if rx.search(n):
            return cat
    return "Other"
