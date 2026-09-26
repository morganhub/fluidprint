// Outils de la barre de gauche : UNE ligne d'import par module d'outils. Le module importé appelle
// `registerTool({ id, label, icon, order, shortcut, create | onPointerDown })` (voir api.ts).
import '../tools/builtinTools';
import '../../panels/IconPicker';
import '../ShapeTool';
import '../PenTool';
