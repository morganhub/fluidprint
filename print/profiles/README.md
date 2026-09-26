# Profils ICC de l'export imprimeur

L'export PDF (phase 4) convertit les photos en CMJN avec le profil du papier choisi, et l'écran simule le
rendu imprimé avec le même profil. Ce dossier contient les profils qui ne sont pas fournis par Windows.

## Déjà présent sur la machine

| Profil | Condition d'impression | Emplacement |
| --- | --- | --- |
| `CoatedFOGRA39.icc` | Offset, papier couché (ISO 12647-2:2004, FOGRA39) | `C:\Windows\System32\spool\drivers\color\CoatedFOGRA39.icc` |

Inutile de le copier ici : l'export le lit à cet emplacement. C'est aussi le profil qui a servi à convertir
les couleurs du design pour le premier nuancier CMJN (décision P1).

## À télécharger

Les profils actuels de la norme ISO 12647-2:2013 sont publiés gratuitement par l'ECI (European Color
Initiative), sur <https://www.eci.org>, rubrique **Downloads**, section des profils ICC. Chaque profil a son
propre paquet ; ils ne font **pas** partie du paquet `ECI_Offset_2009`, qui ne contient que les anciens
profils (ISO Coated v2, PSO Uncoated ISO12647…).

| Profil | Condition d'impression | Paquet à télécharger | Fichier à poser ici |
| --- | --- | --- | --- |
| PSO Coated v3 | Offset, papier couché (FOGRA51) | `pso-coated_v3.zip` | `PSOcoated_v3.icc` |
| PSO Uncoated v3 | Offset, papier non couché (FOGRA52) | `pso-uncoated_v3_fogra52.zip` | `PSOuncoated_v3_FOGRA52.icc` |

1. Télécharger les deux paquets depuis la page Downloads de l'ECI.
2. Extraire de chaque archive le fichier `.icc` (les archives contiennent aussi une documentation PDF,
   inutile ici).
3. Poser les deux fichiers dans ce dossier : `editor/print/profiles/`, sans les renommer.

Le nom exact du fichier `.icc` peut varier légèrement d'une publication à l'autre : garder celui de l'archive.

## Lequel choisir

Demander à l'imprimeur le profil qu'il attend. À défaut : PSO Coated v3 pour un papier couché (brillant ou
mat, le cas le plus courant pour un dépliant), PSO Uncoated v3 pour un papier offset non couché.
FOGRA39 reste accepté par la plupart des imprimeurs qui n'ont pas encore migré vers la norme de 2013.
