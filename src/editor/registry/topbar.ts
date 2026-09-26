// Actions de la barre du haut (Exporter, Aperçu impression, Aperçu plié, Versions…) : UNE ligne
// d'import par module. Le module importé appelle `registerTopbarAction({ id, label, icon, run | component })`.
export {};
import '../FoldPreview';
import '../../text/TypographyDialog';
import '../MasterPages';
import '../../panels/ExportDialog';
import '../PrintPreview';
import '../../word/PlaceWord';
import '../../agent/AgentButton';
