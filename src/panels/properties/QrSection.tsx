// Section QR code du panneau Propriétés (tâche 3.8) : adresse vérifiée avant d'être appliquée (le code se
// redessine en vectoriel), niveau de correction, bouton « Tester » qui ouvre l'adresse, alerte sous
// 15 mm (décision I4 : 15 mm minimum, marge blanche de 4 modules).
import { ExternalLink } from 'lucide-react';
import { create as createQr } from 'qrcode';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input, NativeSelect } from '../../components/ui/input';
import { formatNumber } from '../../components/ui/number-field';
import type { QrObject } from '../../model/types';
import { registerPropertySection, type PropertySectionProps } from '../../editor/registry/api';
import { getEditor } from '../../store/documentStore';
import { common, Field, Section, Warning } from './common';

/** Côté minimal d'un QR code imprimé (décision I4). */
export const MIN_QR_MM = 15;
/** Marge blanche recommandée autour du code, en modules. */
export const QR_QUIET_ZONE = 4;

const ECC_LEVELS: { value: QrObject['ecc']; label: string }[] = [
  { value: 'L', label: 'L · 7 %' },
  { value: 'M', label: 'M · 15 % (conseillé)' },
  { value: 'Q', label: 'Q · 25 %' },
  { value: 'H', label: 'H · 30 %' },
];

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);

/** Vérifie une adresse de QR code ; renvoie l'adresse nettoyée ou un message d'erreur en français. */
export function checkQrUrl(input: string, ecc: QrObject['ecc']): { ok: true; url: string; warning?: string } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Adresse vide.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'Adresse invalide : elle doit commencer par https:// (ou http://, mailto:, tel:).' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { ok: false, error: `Protocole « ${url.protocol} » refusé : utiliser https://, http://, mailto: ou tel:.` };
  if ((url.protocol === 'https:' || url.protocol === 'http:') && !/\.[a-z]{2,}$/i.test(url.hostname) && url.hostname !== 'localhost') {
    return { ok: false, error: `Nom de domaine incomplet : « ${url.hostname} ».` };
  }
  try {
    createQr(text, { errorCorrectionLevel: ecc });
  } catch (error) {
    return { ok: false, error: `Adresse trop longue pour un QR code au niveau ${ecc} : ${(error as Error).message}` };
  }
  return { ok: true, url: text, warning: url.protocol === 'http:' ? 'Adresse non sécurisée (http://) : préférer https://.' : undefined };
}

/** Nombre de modules du code (sans marge) ; null si l'adresse ne se code pas. */
function moduleCount(url: string, ecc: QrObject['ecc']): number | null {
  try {
    return createQr(url, { errorCorrectionLevel: ecc }).modules.size;
  } catch {
    return null;
  }
}

function QrSection({ objects }: PropertySectionProps) {
  const qrs = objects as QrObject[];
  const ids = qrs.map((o) => o.id);
  const url = common(qrs, (o) => (o as QrObject).url);
  const ecc = common(qrs, (o) => (o as QrObject).ecc);
  const [draft, setDraft] = useState(url ?? '');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setDraft(url ?? '');
    setError(null);
  }, [url]);

  const small = qrs.filter((o) => Math.min(o.w, o.h) < MIN_QR_MM - 1e-6);
  const smallest = small.length ? Math.min(...small.map((o) => Math.min(o.w, o.h))) : null;
  const tightMargin = qrs.some((o) => o.margin < QR_QUIET_ZONE);
  const first = qrs[0];
  const modules = qrs.length === 1 ? moduleCount(first.url, first.ecc) : null;
  const moduleMm = modules ? Math.min(first.w, first.h) / (modules + 2 * first.margin) : null;

  const commitUrl = () => {
    if (draft === (url ?? '')) {
      setError(null);
      return;
    }
    // Chaque code garde son niveau de correction : on vérifie l'adresse au plus exigeant d'entre eux.
    const strictest = (['H', 'Q', 'M', 'L'] as const).find((level) => qrs.some((o) => o.ecc === level)) ?? 'M';
    const result = checkQrUrl(draft, strictest);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setNotice(result.warning ?? null);
    getEditor().update<QrObject>(ids, { url: result.url }, 'Adresse du QR code');
  };

  const setEcc = (level: QrObject['ecc']) => {
    const failing = qrs.find((o) => moduleCount(o.url, level) === null);
    if (failing) {
      setError(`Adresse trop longue pour le niveau ${level}.`);
      return;
    }
    getEditor().update<QrObject>(ids, { ecc: level }, 'Correction du QR code');
  };

  return (
    <Section title="QR code" testId="qr">
      <Field label="Adresse">
        <Input
          name="qrUrl"
          aria-label="Adresse du QR code"
          aria-invalid={!!error}
          className={error ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30' : undefined}
          placeholder={url === null ? '— (adresses différentes)' : 'https://…'}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitUrl}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitUrl();
            } else if (e.key === 'Escape') {
              setDraft(url ?? '');
              setError(null);
            }
          }}
        />
      </Field>
      {error && (
        <p role="alert" data-testid="qr-url-error" className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-[12px] text-red-800">
          {error}
        </p>
      )}
      {notice && !error && <Warning testId="qr-url-notice">{notice}</Warning>}
      <Field label="Correction">
        <NativeSelect name="qrEcc" aria-label="Niveau de correction" value={ecc ?? ''} onChange={(e) => setEcc(e.target.value as QrObject['ecc'])}>
          {ecc === null && (
            <option value="" disabled>
              —
            </option>
          )}
          {ECC_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          data-action="test-qr"
          disabled={url === null || !!error}
          onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}
          title="Ouvrir l’adresse dans un nouvel onglet"
        >
          <ExternalLink />
          Tester
        </Button>
        {modules !== null && moduleMm !== null && (
          <span className="text-[11px] text-neutral-500" data-qr-modules>
            {modules} × {modules} modules · {formatNumber(moduleMm, 2)} mm par module
          </span>
        )}
      </div>
      {smallest !== null && (
        <Warning testId="qr-size-warning">
          QR code de {formatNumber(smallest, 1)} mm : en dessous de {MIN_QR_MM} mm, il risque de ne pas se lire. Agrandir à {MIN_QR_MM} × {MIN_QR_MM} mm au moins.
        </Warning>
      )}
      {tightMargin && <Warning testId="qr-margin-warning">Marge blanche de moins de {QR_QUIET_ZONE} modules : certains lecteurs ne trouveront pas le code.</Warning>}
    </Section>
  );
}

registerPropertySection({
  id: 'qr',
  title: 'QR code',
  order: 40,
  appliesTo: (objects) => objects.every((o) => o.type === 'qr'),
  component: QrSection,
});
