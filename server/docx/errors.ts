// Refus d'un fichier Word : le message est destiné à l'utilisateur, tel quel (route → boîte de dialogue).

export type DocxErrorCode =
  /** Rien reçu, ou fichier vide. */
  | 'empty'
  /** Document Word 97-2003 (.doc, conteneur OLE). */
  | 'legacy-doc'
  /** .docx protégé par mot de passe : Word le chiffre dans un conteneur OLE. */
  | 'encrypted'
  /** Ni zip, ni conteneur OLE : un autre format, ou un fichier tronqué. */
  | 'not-zip'
  /** Une archive zip, mais sans word/document.xml. */
  | 'not-word'
  /** Trop lourd, ou trop lourd une fois décompressé (bombe de décompression). */
  | 'too-large'
  /** Archive ou XML principal illisible. */
  | 'corrupt';

export class DocxError extends Error {
  constructor(
    public code: DocxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocxError';
  }
}

/** Une entrée du zip dépasse le budget de décompression (voir `ZIP_LIMITS`). */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}
