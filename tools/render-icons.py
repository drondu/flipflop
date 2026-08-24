import io, os
from PIL import Image, ImageDraw

def rr(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)

def make(size, maskable=False):
    S = 512
    img = Image.new("RGBA", (S, S), (0,0,0,0))
    d = ImageDraw.Draw(img)
    # background: maskable needs full bleed (safe zone is the middle 80%)
    if maskable:
        d.rectangle([0,0,S,S], fill=(14,17,19,255))
        sc, off = 0.72, 72          # shrink art into safe zone
    else:
        rr(d, [0,0,S-1,S-1], 114, (14,17,19,255))
        ov = Image.new("RGBA", (S,S), (0,0,0,0))
        ImageDraw.Draw(ov).rounded_rectangle([4,4,S-5,S-5], radius=111,
                                             outline=(62,207,116,255), width=8)
        ov.putalpha(ov.split()[3].point(lambda a: int(a*0.30)))
        img.alpha_composite(ov); d = ImageDraw.Draw(img)
        sc, off = 1.0, 0

    def T(x, y):
        return (x*sc + (S*(1-sc)/2), y*sc + (S*(1-sc)/2))

    def bar(x, y, w, h, color):
        x0,y0 = T(x,y); x1,y1 = T(x+w, y+h)
        d.rounded_rectangle([x0,y0,x1,y1], radius=int(16*sc), fill=color)

    bar(112,286,52,104, (62,207,116,72))
    bar(192,232,52,158, (62,207,116,133))
    bar(272,170,52,220, (62,207,116,255))

    # upward arrow: elbow + diagonal
    lw = max(2, int(26*sc))
    def line(p0, p1):
        d.line([T(*p0), T(*p1)], fill=(62,207,116,255), width=lw, joint="curve")
    line((352,116),(420,116))
    line((420,116),(420,184))
    line((420,116),(352,184))
    for pt in [(352,116),(420,116),(420,184),(352,184)]:
        cx,cy = T(*pt); r = lw/2
        d.ellipse([cx-r,cy-r,cx+r,cy+r], fill=(62,207,116,255))

    return img.resize((size,size), Image.LANCZOS)

here = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
for n in (192, 512):
    make(n).save(os.path.join(here, f"icon-{n}.png"))
for n in (192, 512):
    make(n, maskable=True).save(os.path.join(here, f"icon-maskable-{n}.png"))
make(180).save(os.path.join(here, "apple-touch-icon.png"))
make(32).save(os.path.join(here, "favicon-32.png"))
print("done")
