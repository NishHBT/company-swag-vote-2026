#!/usr/bin/env python3
"""Normalize the wide Sheet1 swag catalog into a flat static catalog.json.

Reads only product name + approximate price from the workbook (no vendor links,
no colors). Categories come from the verified section mapping. Product IDs are
assigned P01..P60 in reading order (row-major, left-to-right slots).
"""
import json
import os
import re
import unicodedata

SRC = "/home/user/workspace/sheet1_dump.json"
IMG_DIR = "/home/user/workspace/uploaded_attachments/96545dde37934b998679c51af4a03c43"
OUT_SITE = "/home/user/workspace/projects/company-swag-vote-2026-rFmpI1L.S3uRtlqN87R6mQ/files/swag-vote-site/site/data/catalog.json"
OUT_WORKER = "/home/user/workspace/projects/company-swag-vote-2026-rFmpI1L.S3uRtlqN87R6mQ/files/swag-vote-site/worker/src/catalog.js"

# Slot layout in Sheet1: name columns step by 6 starting at column D (index 3).
NAME_COL_START = 3  # 0-based -> column D
STEP = 6
DATA_ROWS = range(4, 16)  # 0-based rows 4..15 == spreadsheet rows 5..16

# Verified section -> category mapping (by product ID range).
CATEGORY_RANGES = [
    (1, 7, "Duffle Bags"),
    (8, 14, "Office Bags"),
    (15, 16, "Heavy-Duty Bags"),
    (17, 21, "Bottles & Mugs"),
    (22, 24, "Notebooks & Office"),
    (25, 27, "Coolers & Lunch"),
    (28, 34, "Desk & Field Essentials"),
    (35, 42, "Tech & Tools"),
    (43, 47, "Gifts & Recreation"),
    (48, 50, "Outerwear"),
    (51, 55, "Men's Apparel"),
    (56, 60, "Women's Apparel"),
]


def category_for(n):
    for lo, hi, name in CATEGORY_RANGES:
        if lo <= n <= hi:
            return name
    raise ValueError(f"no category for P{n:02d}")


# Light presentation cleanups for names that carry stray punctuation or an
# internal buying note in the source cell. Wording otherwise untouched.
NAME_OVERRIDES = {
    "Leeman. Tuscany Tech Padfolio": "Leeman Tuscany Tech Padfolio",
    "Dependable Toiletry Bag - goof for cables and tools management in bags": "Dependable Toiletry Bag (cable & tool organizer)",
    "Luxury Golf Presentation Gift Box - Ball,Divot Tool & Towel": "Luxury Golf Presentation Gift Box - Ball, Divot Tool & Towel",
    "30oz. Stainless Steel Insulated Mug with Handle and Built-In": "30 Oz. Stainless Steel Insulated Mug with Handle",
}


def clean_name(raw):
    # Collapse embedded newlines / dimension notes into a single tidy line.
    s = raw.replace("\n", " ").replace("\r", " ")
    s = re.sub(r"\s+", " ", s).strip()
    s = s.rstrip(".").strip()
    return NAME_OVERRIDES.get(s, s)


def slugify(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s


def norm_key(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]", "", s)


def main():
    rows = json.load(open(SRC))

    # Index supplied photographs by normalized filename stem.
    photos = {}
    for fn in sorted(os.listdir(IMG_DIR)):
        if not fn.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            continue
        stem = os.path.splitext(fn)[0]
        photos[norm_key(stem)] = fn

    products = []
    n = 0
    for r in DATA_ROWS:
        row = rows[r]
        c = NAME_COL_START
        while c < len(row):
            raw = row[c].strip()
            if not raw:
                break
            price_raw = row[c + 1].strip() if c + 1 < len(row) else ""
            n += 1
            name = clean_name(raw)
            try:
                price = int(round(float(price_raw)))
            except ValueError:
                price = None
            pid = f"P{n:02d}"
            key = norm_key(name)
            image = photos.get(key)
            products.append(
                {
                    "id": pid,
                    "name": name,
                    "category": category_for(n),
                    "price": price,
                    "image": f"assets/products/{image}" if image else None,
                    "slug": slugify(name),
                }
            )
            c += STEP

    assert n == 60, f"expected 60 products, got {n}"

    categories = []
    for lo, hi, cname in CATEGORY_RANGES:
        categories.append(
            {
                "id": slugify(cname),
                "name": cname,
                "count": sum(1 for p in products if p["category"] == cname),
            }
        )

    catalog = {
        "title": "Company Swag Vote 2026",
        "org": "Hoffman Building Technologies",
        "version": 1,
        "productCount": len(products),
        "voteOptions": ["Like", "Love", "Don't Like"],
        "categories": categories,
        "products": products,
    }

    os.makedirs(os.path.dirname(OUT_SITE), exist_ok=True)
    with open(OUT_SITE, "w") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
        f.write("\n")

    os.makedirs(os.path.dirname(OUT_WORKER), exist_ok=True)
    server = [
        {"id": p["id"], "name": p["name"], "category": p["category"], "price": p["price"]}
        for p in products
    ]
    with open(OUT_WORKER, "w") as f:
        f.write("// Server-side catalog copy. Generated from the source workbook.\n")
        f.write("// Keep in sync with site/data/catalog.json.\n")
        f.write("export const CATALOG = ")
        json.dump(server, f, indent=2, ensure_ascii=False)
        f.write(";\n\nexport const VOTE_VALUES = ['Like', 'Love', \"Don't Like\"];\n")
        f.write("\nexport const CATALOG_BY_ID = new Map(CATALOG.map((p) => [p.id, p]));\n")

    with_img = [p for p in products if p["image"]]
    print(f"{len(products)} products, {len(with_img)} with supplied photographs")
    for p in with_img:
        print("  ", p["id"], p["category"], "|", p["name"], "->", p["image"])
    unmatched = set(photos.values()) - {os.path.basename(p["image"]) for p in with_img}
    print("unmatched photo files:", sorted(unmatched) or "none")


if __name__ == "__main__":
    main()
