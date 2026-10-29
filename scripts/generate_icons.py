"""Genera los iconos PNG (16/48/128) de la extensión sin dependencias externas."""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
TOP, BOTTOM = (15, 118, 110), (20, 184, 166)  # verde azulado profundo → turquesa


def shade(u: float, v: float):
    """Devuelve (r, g, b, a) para el punto (u, v) en [0, 1]²; un puente colgante sobre fondo redondeado."""
    # Cuadrado redondeado
    r = 0.22
    dx, dy = max(abs(u - 0.5) - (0.5 - r), 0), max(abs(v - 0.5) - (0.5 - r), 0)
    if math.hypot(dx, dy) > r:
        return (0, 0, 0, 0)
    t = (u + v) / 2
    base = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))

    white = False
    # Arco
    d = math.hypot(u - 0.5, (v - 0.74) * 1.15)
    if 0.31 <= d <= 0.37 and v < 0.74:
        white = True
    # Tablero del puente
    if 0.74 <= v <= 0.80 and 0.10 <= u <= 0.90:
        white = True
    # Cables verticales
    for x in (0.34, 0.5, 0.66):
        if abs(u - x) < 0.012 and 0.74 - math.sqrt(max(0, 0.37**2 - (x - 0.5) ** 2)) / 1.15 + 0.02 < v < 0.74:
            white = True
    return (255, 255, 255, 255) if white else (*base, 255)


def render(size: int) -> bytes:
    ss = 4  # supermuestreo para suavizar bordes
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size)
                    a = px[3]
                    acc[0] += px[0] * a
                    acc[1] += px[1] * a
                    acc[2] += px[2] * a
                    acc[3] += a
            n = ss * ss
            alpha = acc[3] / n
            color = [int(acc[i] / acc[3]) if acc[3] else 0 for i in range(3)]
            row += bytes([*color, int(alpha)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for s in (16, 48, 128):
        (OUT / f"icon{s}.png").write_bytes(render(s))
        print(f"icons/icon{s}.png")
