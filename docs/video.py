"""Korte uitlegvideo (±35 s, 1080p) voor dE3p, in de zwart-witte stijl van het programma.
Schermafbeeldingen = demodata uit de handleiding. Uitvoer: mp4 + poster."""
import subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = Path(__file__).parent
IMG = Path('D:/PROJECT/strava-automation/docs/img')
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'video-out'
OUT.mkdir(exist_ok=True)
W, H, FPS = 1920, 1080, 25
BG, FG, SOFT, MUTED, BORDER = (10, 10, 10), (250, 250, 250), (207, 207, 207), (142, 142, 142), (46, 46, 46)
FADE = 0.45


def font(size, wght=800, wdth=118, mono=False):
    f = ImageFont.truetype(str(HERE / ('martian.ttf' if mono else 'archivo.ttf')), size)
    try:
        f.set_variation_by_axes([wght, wdth] if not mono else [wght, 100])
    except Exception:
        pass
    return f


LOGO = Image.open('C:/Users/jensd/Pictures/logo dE3p/Asset 12@3x transparent.png').convert('RGBA')
LOGO = LOGO.crop(LOGO.getbbox())
SRC = HERE / 'video-src'                     # schermen zonder rode ringen + kaarten van andere sporten
SHOTS = {n: Image.open(SRC / f'{n}.webp').convert('RGB') for n in ['v-pagina', 'v-trainingen']}
CARD = Image.open(IMG / 'card.webp').convert('RGB')
# kaarten van andere sporten (demodata), naast de loopkaart
CARDS = [Image.open(SRC / f'{n}.webp').convert('RGB') for n in ('card-zwemmen', 'card-fietsen')] + [CARD]

# (duur, soort, inhoud)
SCENES = [
    (4.0, 'logo', None),
    (7.5, 'vraag', ('Je zwemt.', 'Je fietst.', 'Je loopt.', 'Strava telt alles.', 'Maar waar sta je nu echt?')),
    (8.0, 'shot', ('v-pagina', 'Zie waar je staat', 'Dagen tot je wedstrijd, je training van vandaag en je week. Alles op één pagina.')),
    (8.0, 'shot', ('v-trainingen', 'Een schema op maat', 'Vul je wedstrijd en doeltijd in. Je krijgt elke week je trainingen met doeltempo.')),
    (8.0, 'kaart', ('Een kaart van elke training', 'Zwemmen, fietsen, lopen, kracht: zwart-wit, in het formaat van Instagram en TikTok.')),
]
TOTAL = sum(d for d, *_ in SCENES)


def ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def rounded(im, r, border=None):
    m = Image.new('L', im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, im.width - 1, im.height - 1), r, fill=255)
    out = Image.new('RGBA', im.size)
    out.paste(im, (0, 0), m)
    if border:
        ImageDraw.Draw(out).rounded_rectangle((0, 0, im.width - 1, im.height - 1), r, outline=border, width=3)
    return out


def text_block(d, x, y, lines, f, fill, gap=1.18, fade=1.0):
    for ln in lines:
        c = tuple(int(BG[i] + (fill[i] - BG[i]) * fade) for i in range(3))
        d.text((x, y), ln, font=f, fill=c)
        y += int(f.size * gap)
    return y


def wrap(txt, f, maxw):
    words, lines, cur = txt.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if f.getlength(t) > maxw and cur:
            lines.append(cur); cur = w
        else:
            cur = t
    return lines + [cur]


def label(d, x, y, txt, fade=1.0):
    c = tuple(int(BG[i] + (MUTED[i] - BG[i]) * fade) for i in range(3))
    d.text((x, y), txt.upper(), font=font(22, 500, mono=True), fill=c)


def logo_img(width, alpha=1.0):
    lg = LOGO.resize((width, int(LOGO.height * width / LOGO.width)), Image.LANCZOS)
    if alpha < 1:
        a = lg.split()[3].point(lambda v: int(v * alpha))
        lg.putalpha(a)
    return lg


def scene(i, t):
    dur, kind, c = SCENES[i]
    p = t / dur
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    ina = ease(t / 0.8)

    if kind == 'logo':
        s = 520 + int(60 * p)
        lg = logo_img(s, ina)
        im.paste(lg, ((W - lg.width) // 2, (H - lg.height) // 2 - 40), lg)

    elif kind == 'vraag':
        f = font(92, 800, 118)
        y = 170
        for n, ln in enumerate(c):
            a = ease((t - n * 0.9) / 0.5)
            col = FG if n < 2 else FG
            text_block(d, 140, y + int(20 * (1 - a)), [ln], f, col if n < 2 else FG, fade=a if n < 2 else a)
            y += 150 if n != 2 else 190      # witregel na 'Je loopt.'
        # laatste regel iets zachter voor de eerste twee
    elif kind in ('shot', 'kaart'):
        if kind == 'shot':
            name, title, body = c
            src = SHOTS[name]
        else:
            title, body = c
            src = None
        # tekst links
        f1 = font(74, 800, 118)
        y = text_block(d, 110, 380 + int(16 * (1 - ina)), wrap(title, f1, 560), f1, FG, 1.08, ina)
        f2 = font(32, 400, 100)
        a2 = ease((t - 0.5) / 0.8)
        text_block(d, 110, y + 26, wrap(body, f2, 540), f2, SOFT, 1.45, a2)
        # beeld rechts, langzaam inzoomend
        z = 1.0 + 0.05 * p
        if src is not None:
            bw = int(1080 * z); bh = int(src.height * bw / src.width)
            shot = rounded(src.resize((bw, bh), Image.LANCZOS), 22, BORDER)
            cx, cy = 720 + 1080 // 2, H // 2
        else:
            bh = int(600 * z); bw = int(CARD.width * bh / CARD.height); g = 24
            shot = Image.new('RGBA', (3 * bw + 2 * g, bh))
            for k, cimg in enumerate(CARDS):
                ck = rounded(cimg.resize((bw, bh), Image.LANCZOS), 22, BORDER)
                ak = ease((t - 0.2 - k * 0.35) / 0.6)
                ck.putalpha(ck.split()[3].point(lambda v, ak=ak: int(v * ak)))
                shot.paste(ck, (k * (bw + g), 0), ck)
            cx, cy = 1300, H // 2
        off = int(40 * (1 - ina))
        if ina < 1:
            a = shot.split()[3].point(lambda v: int(v * ina)); shot.putalpha(a)
        im.paste(shot, (cx - shot.width // 2 + off, cy - shot.height // 2), shot)

    elif kind == 'feiten':
        f = font(84, 800, 118)
        y = 250
        for n, ln in enumerate(c):
            a = ease((t - 0.3 - n * 0.9) / 0.6)
            d.ellipse((140, y + 34, 164, y + 58), fill=tuple(int(BG[k] + (FG[k] - BG[k]) * a) for k in range(3)))
            text_block(d, 200 + int(20 * (1 - a)), y, [ln], f, FG, fade=a)
            y += 150

    elif kind == 'cta':
        lg = logo_img(300, ina)
        im.paste(lg, ((W - lg.width) // 2, 250), lg)
        f1 = font(96, 800, 118)
        t1 = 'Download gratis'
        a1 = ease((t - 0.5) / 0.7)
        d.text(((W - f1.getlength(t1)) / 2, 470), t1, font=f1,
               fill=tuple(int(BG[k] + (FG[k] - BG[k]) * a1) for k in range(3)))
        f2 = font(52, 500, mono=True)
        t2 = 'de3p.be/download'
        a2 = ease((t - 1.1) / 0.7)
        tw = f2.getlength(t2)
        bx0, by0 = (W - tw) / 2 - 44, 630
        box = tuple(int(BG[k] + (FG[k] - BG[k]) * a2) for k in range(3))
        d.rounded_rectangle((bx0, by0, bx0 + tw + 88, by0 + 104), 52, fill=box)
        d.text(((W - tw) / 2, by0 + 22), t2, font=f2, fill=BG)
        f3 = font(28, 400, 100)
        t3 = 'Windows · Mac volgt binnenkort · handleiding stap voor stap'
        a3 = ease((t - 1.7) / 0.7)
        d.text(((W - f3.getlength(t3)) / 2, 790), t3, font=f3,
               fill=tuple(int(BG[k] + (MUTED[k] - BG[k]) * a3) for k in range(3)))

    # eind van de scène: uitfaden naar zwart wordt gedaan door de overgang
    return im


def frame(t):
    acc = 0.0
    for i, (dur, *_ ) in enumerate(SCENES):
        if t < acc + dur or i == len(SCENES) - 1:
            lt = t - acc
            cur = scene(i, lt)
            if i < len(SCENES) - 1 and lt > dur - FADE:
                nxt = scene(i + 1, 0.0)
                cur = Image.blend(cur, nxt, ease((lt - (dur - FADE)) / FADE))
            if i == len(SCENES) - 1 and lt > dur - 0.8:     # einde: rustig naar zwart
                cur = Image.blend(cur, Image.new('RGB', (W, H), BG), ease((lt - (dur - 0.8)) / 0.8))
            return cur
        acc += dur


def main():
    mp4 = OUT / 'dE3p.mp4'
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
           '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p',
           '-movflags', '+faststart', str(mp4)]
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    n = int(TOTAL * FPS)
    for k in range(n):
        pr.stdin.write(frame(k / FPS).tobytes())
    pr.stdin.close(); pr.wait()
    # poster: het overzicht-shot midden in beeld
    frame(sum(d for d, *_ in SCENES[:2]) + 4.0).save(OUT / 'dE3p-poster.jpg', quality=88)
    # controlebeelden
    for s in (2.0, 7.5, 13.0, 21.0, 31.0):
        frame(s).resize((640, 360)).save(OUT / f'check-{s:04.1f}.jpg', quality=80)
    print(mp4, round(mp4.stat().st_size / 1e6, 1), 'MB', TOTAL, 's')


if __name__ == '__main__':
    main()
