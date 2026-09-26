"""Épreuvage écran des photos (tâche 4.9) : aperçu RVB → CMJN (profil de sortie, intention et encrage
du préréglage, exactement comme à l'export) → RVB (simulation à l'écran, comme les nuances).

Usage : python proof.py <source> <destination.webp> [--profile FOGRA39] [--intent perceptual] [--max-ink 300]
Le fichier de destination sert de cache : il n'est refait que si la source est plus récente.
Réponse JSON : {"output", "cached", "width", "height"}.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageCms

from printcore import PrintError, emit, fail, resolve_profile, rgb_image_to_cmyk, transform_to_rgb


def proof_image(img: Image.Image, profile: Path, intent: str = "perceptual", bpc: bool = True, max_ink: float | None = None) -> Image.Image:
    """Image telle que l'imprimera le profil, vue à l'écran (sRGB). La transparence est gardée."""
    icc = img.info.get("icc_profile")
    alpha = img.getchannel("A") if img.mode in ("RGBA", "LA", "PA") else None
    rgb = img.convert("RGB")
    cmyk = rgb_image_to_cmyk(rgb, profile, intent, bpc, icc, max_ink)
    back = ImageCms.applyTransform(cmyk, transform_to_rgb(profile, "relative", bpc))
    if alpha is not None:
        back.putalpha(alpha)
    return back


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--profile", default="FOGRA39")
    parser.add_argument("--intent", default="perceptual")
    parser.add_argument("--max-ink", type=float, default=None)
    parser.add_argument("--no-bpc", action="store_true")
    args = parser.parse_args()
    source, destination = Path(args.source), Path(args.destination)
    try:
        if not source.is_file():
            raise PrintError(f"Photo introuvable : {source}")
        if destination.is_file() and destination.stat().st_mtime >= source.stat().st_mtime:
            with Image.open(destination) as cached:
                emit({"output": str(destination), "cached": True, "width": cached.width, "height": cached.height})
            return
        profile, _ = resolve_profile(args.profile)
        with Image.open(source) as img:
            img.load()
            proofed = proof_image(img, profile, args.intent, not args.no_bpc, args.max_ink)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Écriture par un fichier temporaire : un aperçu à moitié écrit ne doit jamais passer pour le cache.
        partial = destination.with_suffix(destination.suffix + ".part")
        proofed.save(partial, format="WEBP", quality=90, method=4)
        partial.replace(destination)
        emit({"output": str(destination), "cached": False, "width": proofed.width, "height": proofed.height})
    except PrintError as error:
        fail(str(error))


if __name__ == "__main__":
    main()
