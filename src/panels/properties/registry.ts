// Sections du panneau Propriétés : UNE ligne d'import par section. Le module importé appelle
// `registerPropertySection({ id, title, order, appliesTo, component })` (editor/registry/api.ts).
// Ordres : Position et taille 10, Alignement 15, Apparence 20, Texte 30, Style de paragraphe 35,
// QR code 40, Image 50.
import './PositionSection';
import './AppearanceSection';
import './TextSection';
import './RotationSection';
import './AlignSection';
import './QrSection';
import './FrameSection';
import './ParagraphStyleSection';
import '../../text/threadingUi';
import '../../text/wrapUi';
