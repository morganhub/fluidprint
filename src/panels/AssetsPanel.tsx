// Panneau Images (tâche 3.6), façon « Liens » d'InDesign : chaque photo du document, sa taille d'origine,
// sa résolution effective dans chaque cadre où elle sert, et « Remplacer ». Le même module pose le badge
// de résolution sur les cadres (orange sous 250 ppi, rouge sous 150 ppi, décision I2).
import { Images, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../components/ui/button';
import { ACCEPT_ATTRIBUTE, ASSET_DRAG_TYPE, uploadImage } from '../editor/dropImage';
import { registerOverlay, registerPanel, type PageOverlayProps } from '../editor/registry/api';
import { assetUsages, framePpi, PPI_ERROR, PPI_WARN, printedSizeMm, relinkImage, type AssetUsage, type PpiLevel } from '../model/images';
import type { Asset, DocObject, Id, LayoutDocument } from '../model/types';
import { defaultImageResolver } from '../render/context';
import { getEditor, useEditor } from '../store/documentStore';
import { objectBounds } from '../store/tree';

const LEVEL_CLASS: Record<PpiLevel, string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  error: 'text-red-700',
};

const formatMm = (v: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(v);

/** Remplace une photo partout où elle sert (le fichier de l'ancienne reste dans assets/). */
export function replaceAsset(oldId: Id, asset: Asset): void {
  getEditor().apply('Remplacer une photo', (d) => {
    const index = d.assets.findIndex((a) => a.id === oldId);
    if (index < 0) return;
    if (d.assets.some((a) => a.id === asset.id)) d.assets.splice(index, 1);
    else d.assets[index] = asset;
    for (const obj of Object.values(d.objects)) {
      if (obj.type === 'frame' && obj.image?.assetId === oldId) obj.image = relinkImage(obj, obj.image, asset);
    }
  });
}

function FilePicker({ label, multiple, onFiles, testId, icon }: { label: string; multiple?: boolean; onFiles(files: File[]): void; testId: string; icon?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length) onFiles(files);
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => input.current?.click()} data-action={testId}>
        {icon && <Upload />}
        {label}
      </Button>
      <input ref={input} type="file" accept={ACCEPT_ATTRIBUTE} multiple={multiple} className="hidden" onChange={onChange} data-file-input={testId} />
    </>
  );
}

function UsageRow({ usage }: { usage: AssetUsage }) {
  const show = () => {
    const s = getEditor();
    s.select([usage.frameId]);
    getEditor().centerOn([usage.frameId]);
  };
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-neutral-100"
        onClick={show}
        data-asset-usage={usage.frameId}
        data-ppi-level={usage.level}
        title="Sélectionner le cadre"
      >
        <span className="min-w-0 truncate">
          {usage.name}
          {usage.pageName && <span className="text-neutral-400"> · {usage.pageName}</span>}
        </span>
        <span className={`shrink-0 font-medium tabular-nums ${LEVEL_CLASS[usage.level]}`}>{Math.round(usage.ppi)} ppi</span>
      </button>
    </li>
  );
}

function AssetRow({ asset, usages, docId }: { asset: Asset; usages: AssetUsage[]; docId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = defaultImageResolver(docId, 'screen')(asset);
  const worst = usages.reduce<PpiLevel | null>((acc, u) => (u.level === 'error' || acc === 'error' ? 'error' : u.level === 'warn' || acc === 'warn' ? 'warn' : 'ok'), null);

  const replace = async ([file]: File[]) => {
    setBusy(true);
    setError(null);
    try {
      replaceAsset(asset.id, await uploadImage(docId, file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    getEditor().apply('Retirer une photo', (d) => {
      d.assets = d.assets.filter((a) => a.id !== asset.id);
    });

  return (
    <li className="border-b border-neutral-200 px-3 py-2.5" data-asset-row={asset.id}>
      <div className="flex gap-2.5">
        <img
          src={url}
          alt=""
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          className="size-14 shrink-0 cursor-grab rounded border border-neutral-200 bg-[repeating-conic-gradient(#eee_0_25%,#fff_0_50%)] bg-[length:8px_8px] object-contain"
          title="Glisser sur une forme pour l’y placer"
        />
        <div className="min-w-0 flex-1 text-[12px]">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-neutral-800" title={asset.original}>
              {asset.name}
            </span>
            {asset.placeholder && (
              <span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase text-amber-800" data-asset-placeholder>
                Provisoire
              </span>
            )}
          </div>
          <div className="text-neutral-500" data-asset-size>
            {asset.width} × {asset.height} px · {formatMm(printedSizeMm(asset.width, 300))} × {formatMm(printedSizeMm(asset.height, 300))} mm à 300 ppi
          </div>
          {usages.length ? (
            <ul className="mt-1">
              {usages.map((u) => (
                <UsageRow key={u.frameId} usage={u} />
              ))}
            </ul>
          ) : (
            <div className="mt-1 text-neutral-400" data-asset-unplaced title="Glisser la vignette sur un cadre pour y placer la photo">
              Non placée
            </div>
          )}
          {worst && worst !== 'ok' && (
            <p className={`mt-1 ${LEVEL_CLASS[worst]}`}>
              {worst === 'error' ? `Sous ${PPI_ERROR} ppi : floue à l’impression.` : `Sous ${PPI_WARN} ppi : risque de flou.`}
              {asset.placeholder ? ' Photo provisoire : à remplacer par l’original.' : ''}
            </p>
          )}
          <div className="mt-1.5 flex gap-1.5">
            <FilePicker label={busy ? 'Envoi…' : 'Remplacer…'} onFiles={replace} testId={`replace-${asset.id}`} />
            {!usages.length && (
              <Button variant="ghost" size="sm" onClick={remove} data-action={`remove-asset-${asset.id}`}>
                Retirer
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-1 text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export function AssetsPanel() {
  const doc = useEditor((s) => s.doc);
  const docId = useEditor((s) => s.docId);
  const [error, setError] = useState<string | null>(null);
  if (!doc) return null;
  const usages = assetUsages(doc);
  const id = docId ?? doc.id;

  const importFiles = async (files: File[]) => {
    setError(null);
    try {
      const assets: Asset[] = [];
      for (const file of files) assets.push(await uploadImage(id, file));
      getEditor().apply(assets.length > 1 ? 'Importer des photos' : 'Importer une photo', (d) => {
        for (const a of assets) if (!d.assets.some((x) => x.id === a.id)) d.assets.push(a);
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div data-assets-panel>
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
        <span className="text-[12px] text-neutral-500">
          {doc.assets.length} photo{doc.assets.length > 1 ? 's' : ''}
        </span>
        <FilePicker label="Importer…" multiple icon onFiles={importFiles} testId="import-images" />
      </div>
      {error && (
        <p role="alert" className="mx-3 mt-2 text-[12px] text-red-700">
          {error}
        </p>
      )}
      {doc.assets.length ? (
        <ul>
          {doc.assets.map((a) => (
            <AssetRow key={a.id} asset={a} usages={usages.get(a.id) ?? []} docId={id} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-4 text-[13px] text-neutral-500">
          Aucune photo. Glissez un fichier JPG, PNG, TIFF ou WebP depuis l’explorateur sur une forme, ou importez-le ici.
        </p>
      )}
    </div>
  );
}

registerPanel({ id: 'images', title: 'Images', icon: Images, order: 50, component: AssetsPanel });

// ---------------------------------------------------------------- badge de résolution sur les cadres

function framesOf(doc: LayoutDocument, ids: Id[]): DocObject[] {
  return ids.flatMap((id) => {
    const obj = doc.objects[id];
    if (!obj || obj.hidden) return [];
    return obj.type === 'group' ? framesOf(doc, obj.children) : obj.type === 'frame' ? [obj] : [];
  });
}

/** Badge « 110 ppi » au coin haut-droit de chaque cadre sous le seuil (taille constante à l'écran). */
function PpiBadges({ doc, page, zoom }: PageOverlayProps) {
  const hiddenLayers = new Set(doc.layers.filter((l) => !l.visible).map((l) => l.id));
  const badges = framesOf(doc, page.children)
    .filter((f) => !hiddenLayers.has(f.layerId))
    .map((f) => framePpi(doc, f))
    .filter((info) => !!info && info.level !== 'ok');
  return (
    <>
      {badges.map((info) => {
        const b = objectBounds(info!.frame);
        return (
          <div
            key={info!.frame.id}
            data-ppi-badge={info!.level}
            data-frame-id={info!.frame.id}
            title={`Résolution effective : ${Math.round(info!.ppi)} ppi (${info!.level === 'error' ? `sous ${PPI_ERROR}` : `sous ${PPI_WARN}`} ppi)`}
            style={{
              position: 'absolute',
              left: `${b.x + b.w}mm`,
              top: `${b.y}mm`,
              transform: `translate(-100%, 0) scale(${1 / zoom})`,
              transformOrigin: '100% 0',
              margin: 0,
              padding: '1px 5px',
              borderRadius: 4,
              font: '600 10px/14px system-ui, sans-serif',
              color: '#fff',
              background: info!.level === 'error' ? '#dc2626' : '#f59e0b',
              boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
              whiteSpace: 'nowrap',
            }}
          >
            {Math.round(info!.ppi)} ppi
          </div>
        );
      })}
    </>
  );
}

registerOverlay({ id: 'ppi-badges', space: 'page', order: 30, component: PpiBadges });
