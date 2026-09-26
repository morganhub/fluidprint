import { EditorApp } from './editor/EditorApp';
import { PrintRoute } from './render/PrintRoute';
import { DocumentList } from './viewer/DocumentList';
import { Viewer } from './viewer/Viewer';

// Routage par le chemin, sans bibliothèque : quatre écrans, et la route d'impression doit rester
// une page nue que Puppeteer ouvre directement. /doc/:id est l'éditeur ; /view/:id, la visionneuse
// en lecture seule de la phase 1.
function route(pathname: string) {
  const match = /^\/(print|doc|view)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return <DocumentList />;
  const docId = decodeURIComponent(match[2]);
  if (match[1] === 'print') return <PrintRoute docId={docId} />;
  if (match[1] === 'view') return <Viewer docId={docId} />;
  return <EditorApp docId={docId} />;
}

export function App() {
  return route(location.pathname);
}
