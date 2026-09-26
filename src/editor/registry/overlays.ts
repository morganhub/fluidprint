// Surcouches du plan de travail (repères, règles, recadrage, plume…) : UNE ligne d'import par module.
// Le module importé appelle `registerOverlay({ id, space: 'page' | 'viewport', component })` (voir api.ts).
export {};
import '../PageGuides';
import '../Guides';
import '../Rulers';
import '../CropMode';
import '../DropImageOverlay';
import '../../text/overset';
