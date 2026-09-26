import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installAgentApi } from './agent/api';
import { App } from './App';
import './styles/app.css';

// `window.fluidprint` : un agent IA de navigateur pilote l'accueil et l'éditeur par programme (bouton « IA Agent »).
// La route d'impression, lue par l'export, n'en a pas besoin.
if (!location.pathname.startsWith('/print/')) installAgentApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
