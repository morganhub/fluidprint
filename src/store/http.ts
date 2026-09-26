// Requêtes vers le serveur local de l'éditeur. Une panne réseau (serveur arrêté, connexion coupée) fait
// échouer fetch sur une TypeError au message anglais (« Failed to fetch ») : c'est ce texte qui s'affichait
// tel quel. On le remplace par un message français, suivi de ce qui va se passer.

export const SERVER_UNREACHABLE = 'Serveur injoignable';

/** `fetch`, avec une erreur réseau en français (`hint` : la suite, ex. « nouvel essai dans 5 s »). */
export async function serverFetch(input: string, init?: RequestInit, hint?: string): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    // Une requête annulée volontairement n'est pas une panne.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(hint ? `${SERVER_UNREACHABLE} : ${hint}` : SERVER_UNREACHABLE, { cause: error });
  }
}
