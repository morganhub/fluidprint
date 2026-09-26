"""Conversions de couleurs isolées pour le serveur (server/color.ts) : JSON sur l'entrée standard.

Entrée : {"op": "cmyk-to-rgb" | "rgb-to-cmyk", "profile": "FOGRA39", "values": [...],
          "intent"?: "relative", "bpc"?: true, "maxInk"?: 300}
Sortie : {"values": [...], "profile": "<chemin du profil>"}
"""
from __future__ import annotations

import json
import sys

from printcore import PrintError, cmyk_list_to_rgb, emit, fail, resolve_profile, rgb_list_to_cmyk


def main() -> None:
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
        path, _ = resolve_profile(request.get("profile") or "FOGRA39")
        intent = request.get("intent") or "relative"
        bpc = bool(request.get("bpc", True))
        values = request.get("values") or []
        if request.get("op") == "cmyk-to-rgb":
            out = cmyk_list_to_rgb(values, path, intent, bpc)
        elif request.get("op") == "rgb-to-cmyk":
            out = rgb_list_to_cmyk(values, path, intent, bpc, request.get("maxInk"))
        else:
            raise PrintError(f"Opération inconnue : {request.get('op')}")
        emit({"values": out, "profile": str(path)})
    except PrintError as error:
        fail(str(error))


if __name__ == "__main__":
    main()
