import type { LayoutDocument } from '../model/types';

/** Graisses et styles employés par les textes du document, au format de `document.fonts.load`. */
export function usedFonts(doc: LayoutDocument): string[] {
  const fonts = new Set<string>();
  for (const obj of Object.values(doc.objects)) {
    if (obj.type !== 'text') continue;
    const family = obj.style.fontFamily;
    const add = (weight: number, italic?: boolean) => fonts.add(`${italic ? 'italic ' : ''}${weight} 16px '${family}'`);
    add(obj.style.fontWeight, obj.style.italic);
    for (const para of obj.paragraphs) for (const run of para.runs) add(run.fontWeight ?? obj.style.fontWeight, run.italic ?? obj.style.italic);
  }
  return [...fonts];
}

/** Charge explicitement les polices du document : `document.fonts.ready` seul ne couvre que les
 *  chargements déjà demandés par la mise en page, et peut donc se résoudre trop tôt. */
export async function loadDocumentFonts(doc: LayoutDocument): Promise<void> {
  await Promise.all(usedFonts(doc).map((font) => document.fonts.load(font)));
  await document.fonts.ready;
}
