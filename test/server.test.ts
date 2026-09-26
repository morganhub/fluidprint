import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import { createHash, randomFillSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Asset, LayoutDocument } from '../src/model/types';
import { validateDocument } from '../src/model/validate';
import { DEFAULT_PORT, startServer, type RunningServer } from '../server/app';
import { HISTORY_LIMIT, saveDocument } from '../server/documents';
import { PROJECT_ROOT } from '../server/paths';
import { registerApiRoutes } from '../server/routes';
import { minimalDoc } from './fixtures/minimal-doc';
import { withTempDocuments } from './helpers/browser';

interface ServerContext {
  server: RunningServer;
  url: string;
  dir: string;
}

// Un serveur et un dossier de documents neufs par test : aucun test ne dépend de l'état laissé par un autre.
function withServer<T>(fn: (ctx: ServerContext) => Promise<T>): Promise<T> {
  return withTempDocuments(async (dir) => {
    const server = await startServer({ dev: true, hmr: false, port: 0, documentsDir: dir });
    try {
      return await fn({ server, url: server.url, dir });
    } finally {
      await server.close();
    }
  });
}

function docWithId(id: string, name = 'Essai'): LayoutDocument {
  return { ...minimalDoc(), id, name };
}

async function seedDocument(dir: string, doc: LayoutDocument): Promise<string> {
  const file = path.join(dir, doc.id, 'document.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

const putJson = (url: string, body: unknown) =>
  fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function imageForm(data: Uint8Array, filename: string, type: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type }), filename);
  return form;
}

function upload(url: string, id: string, data: Uint8Array, filename: string, type: string) {
  return fetch(`${url}/api/assets/${id}`, { method: 'POST', body: imageForm(data, filename, type) });
}

async function multipartBody(data: Uint8Array, filename: string, type: string): Promise<{ contentType: string; payload: Buffer }> {
  const encoded = new Response(imageForm(data, filename, type));
  return { contentType: encoded.headers.get('content-type')!, payload: Buffer.from(await encoded.arrayBuffer()) };
}

// fetch normalise « .. » (même écrit %2e%2e) avant l'envoi : pour tester le serveur face à un chemin brut, on passe par http.
function rawRequest(
  url: string,
  method: string,
  requestPath: string,
  body?: { contentType: string; payload: Buffer },
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(url);
  const headers = body ? { 'content-type': body.contentType, 'content-length': body.payload.length } : {};
  return new Promise((resolve, reject) => {
    const req = http.request({ host: hostname, port, method, path: requestPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body?.payload);
  });
}

function tryConnect(host: string, port: number): Promise<'connecte' | 'refuse'> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connecte');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('refuse');
    });
    socket.once('error', () => resolve('refuse'));
  });
}

const sha1 = (data: Uint8Array) => createHash('sha1').update(data).digest('hex');

async function pixel(input: Buffer): Promise<number[]> {
  const { data } = await sharp(input).resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data];
}

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 220, g: 30, b: 40 } } });

describe('serveur local', () => {
  it("n'écoute que sur 127.0.0.1", async () => {
    await withServer(async ({ server, url }) => {
      const address = server.app.server.address() as net.AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${url}/api/health`)).status).toBe(200);

      // Depuis une autre interface de la machine (réseau local, IPv6), la connexion doit échouer.
      const others = Object.values(os.networkInterfaces())
        .flat()
        .filter((iface) => iface && !iface.internal && iface.family === 'IPv4')
        .map((iface) => iface!.address);
      for (const host of [...others.slice(0, 2), '::1']) {
        expect(await tryConnect(host, address.port), host).toBe('refuse');
      }
    });
  });

  it('port par défaut hors de la plage de fluidplan ; port déjà pris : une ligne qui dit comment relancer, code 1', async () => {
    // fluidplan essaie 5178 puis les 9 ports suivants : 5180 était souvent déjà pris.
    expect(DEFAULT_PORT < 5178 || DEFAULT_PORT > 5187).toBe(true);
    const busy = http.createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const { port } = busy.address() as net.AddressInfo;
    try {
      const run = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const proc = spawn(process.execPath, ['--import', 'tsx', path.join(PROJECT_ROOT, 'server', 'index.ts'), '--dev'], {
          cwd: PROJECT_ROOT,
          env: { ...process.env, PORT: String(port) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        proc.once('error', reject);
        proc.once('exit', (code) => resolve({ code, stderr }));
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`Le port ${port} est déjà pris`);
      expect(run.stderr).toContain(`PORT=${port + 1} npm run dev`);
      expect(run.stderr).not.toMatch(/^\s+at /m);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it('liste les documents, en lit un, répond 404 pour un absent', async () => {
    await withServer(async ({ url, dir }) => {
      expect(await (await fetch(`${url}/api/doc`)).json()).toEqual([]);

      const doc = docWithId('essai');
      await seedDocument(dir, doc);
      await seedDocument(dir, docWithId('autre', 'Autre document'));
      await mkdir(path.join(dir, 'dossier-vide'));
      await mkdir(path.join(dir, 'Nom Invalide'));
      await writeFile(path.join(dir, 'fichier.txt'), 'pas un document');

      const list = await (await fetch(`${url}/api/doc`)).json();
      expect(list).toEqual(
        expect.arrayContaining([
          { id: 'essai', name: 'Essai' },
          { id: 'autre', name: 'Autre document' },
        ]),
      );
      expect(list).toHaveLength(2);

      const res = await fetch(`${url}/api/doc/essai`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(doc);

      const missing = await fetch(`${url}/api/doc/absent`);
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toMatch(/introuvable/);

      // Un document.json abîmé est signalé, pas servi à moitié.
      await mkdir(path.join(dir, 'abime'));
      await writeFile(path.join(dir, 'abime', 'document.json'), '{"version": 2, "id": "abi');
      expect((await fetch(`${url}/api/doc/abime`)).status).toBe(422);
    });
  });

  it("PUT enregistre un document valide, relu à l'identique", async () => {
    await withServer(async ({ url, dir }) => {
      const doc = docWithId('nouveau', 'Nouveau document');
      const res = await putJson(`${url}/api/doc/nouveau`, doc);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, id: 'nouveau' });

      // Le fichier contient le document validé (zod peut réordonner les clés, pas changer les valeurs), indenté pour git.
      const file = path.join(dir, 'nouveau', 'document.json');
      const written = await readFile(file, 'utf8');
      expect(JSON.parse(written)).toEqual(doc);
      expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
      expect(await (await fetch(`${url}/api/doc/nouveau`)).json()).toEqual(doc);

      const edited = structuredClone(doc);
      edited.name = 'Nouveau document (retouché)';
      const text = edited.objects.t1;
      if (text.type !== 'text') throw new Error('t1 devrait être un texte');
      text.paragraphs[0].runs[0].text = 'Une formation « sur mesure », ';
      expect((await putJson(`${url}/api/doc/nouveau`, edited)).status).toBe(200);
      expect(await (await fetch(`${url}/api/doc/nouveau`)).json()).toEqual(edited);
      expect((await readdir(path.join(dir, 'nouveau'))).sort()).toEqual(['document.json']);
    });
  });

  it('PUT avec la révision lue : 409 si le fichier a changé depuis, sans rien écrire ; sans révision, écriture libre', async () => {
    await withServer(async ({ url, dir }) => {
      const file = await seedDocument(dir, docWithId('essai'));
      const opened = await fetch(`${url}/api/doc/essai?open=1`);
      const base = opened.headers.get('x-doc-revision');
      expect(base).toMatch(/^[0-9a-f]{16}$/);
      const put = (body: unknown, revision?: string | null) =>
        fetch(`${url}/api/doc/essai`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(revision ? { 'x-base-revision': revision } : {}) }, body: JSON.stringify(body) });

      // Onglet B : enregistre sur la révision lue ; la réponse donne la nouvelle révision.
      const b = await put(docWithId('essai', 'Onglet B'), base);
      expect(b.status).toBe(200);
      const bBody = await b.json();
      expect(bBody.revision).toMatch(/^[0-9a-f]{16}$/);
      expect(bBody.revision).not.toBe(base);
      expect(b.headers.get('x-doc-revision')).toBe(bBody.revision);

      // Onglet A, ouvert avant : même révision de départ, refusé, fichier intact.
      const a = await put(docWithId('essai', 'Onglet A'), base);
      expect(a.status).toBe(409);
      expect(await a.json()).toMatchObject({ conflict: true, revision: bBody.revision, error: expect.stringContaining('modifié ailleurs') });
      expect(JSON.parse(await readFile(file, 'utf8')).name).toBe('Onglet B');

      // Sur la bonne révision (celle que renvoie un GET), l'écriture passe ; sans en-tête (scripts), toujours.
      const current = (await fetch(`${url}/api/doc/essai`)).headers.get('x-doc-revision');
      expect(current).toBe(bBody.revision);
      expect((await put(docWithId('essai', 'Onglet A, rechargé'), current)).status).toBe(200);
      expect((await put(docWithId('essai', 'Script'))).status).toBe(200);
      expect(JSON.parse(await readFile(file, 'utf8')).name).toBe('Script');
    });
  });

  it("PUT refuse un document invalide (422) avec le chemin de l'erreur, sans toucher au fichier", async () => {
    await withServer(async ({ url, dir }) => {
      const doc = docWithId('essai');
      const file = await seedDocument(dir, doc);
      const before = await readFile(file, 'utf8');

      const wrongType = structuredClone(doc) as unknown as { objects: { r1: { w: unknown } } };
      wrongType.objects.r1.w = 'large';
      let res = await putJson(`${url}/api/doc/essai`, wrongType);
      expect(res.status).toBe(422);
      let body = await res.json();
      expect(body.path).toBe('objects.r1.w');
      expect(body.error).toContain('objects.r1.w');

      // Erreur de cohérence (nuance inconnue) : même forme de réponse.
      const unknownSwatch = structuredClone(doc);
      unknownSwatch.objects.r1 = { ...unknownSwatch.objects.r1, fill: { swatch: 'fuchsia' } } as typeof unknownSwatch.objects.r1;
      res = await putJson(`${url}/api/doc/essai`, unknownSwatch);
      expect(res.status).toBe(422);
      body = await res.json();
      expect(body.path).toMatch(/^objects\.r1\.fill/);

      res = await putJson(`${url}/api/doc/essai`, docWithId('pas-le-meme'));
      expect(res.status).toBe(422);
      expect((await res.json()).path).toBe('id');

      res = await fetch(`${url}/api/doc/essai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"version": 2,' });
      expect(res.status).toBe(400);

      expect(await readFile(file, 'utf8')).toBe(before);
    });
  });

  it("un arrêt brutal pendant l'écriture ne corrompt pas document.json", async () => {
    await withTempDocuments(async (dir) => {
      const initial = docWithId('essai', 'Version initiale');
      const file = await seedDocument(dir, initial);
      const docDir = path.dirname(file);

      // Deux versions lourdes (≈ 8 Mo) : l'écriture dure assez longtemps pour que le processus soit tué en plein milieu.
      const heavy = (name: string, letter: string) => {
        const doc = docWithId('essai', name);
        const text = doc.objects.t1;
        if (text.type === 'text') text.paragraphs[0].runs[0].text = letter.repeat(8_000_000);
        return doc;
      };
      const docsFile = path.join(dir, 'versions.json');
      await writeFile(docsFile, JSON.stringify([heavy('Version A', 'a'), heavy('Version B', 'b')]));
      const child = path.join(dir, 'ecrivain.mjs');
      await writeFile(
        child,
        [
          "import { readFileSync } from 'node:fs';",
          "import { pathToFileURL } from 'node:url';",
          'const [modulePath, dir, docsFile] = process.argv.slice(2);',
          'const { saveDocument } = await import(pathToFileURL(modulePath).href);',
          "const docs = JSON.parse(readFileSync(docsFile, 'utf8'));",
          "for (let i = 0; ; i++) { await saveDocument(dir, 'essai', docs[i % 2]); process.stdout.write('ok\\n'); }",
        ].join('\n'),
      );

      const isTemp = (name: string) => /^document\.json\.\d+-[0-9a-f]{8}\.tmp$/.test(name);
      let interruptedMidWrite = 0;
      const runs = 4;
      for (let run = 0; run < runs; run++) {
        const proc = spawn(process.execPath, ['--import', 'tsx', child, path.join(PROJECT_ROOT, 'server', 'documents.ts'), dir, docsFile], {
          cwd: PROJECT_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let saves = 0;
        let stderr = '';
        proc.stdout.on('data', (chunk: Buffer) => (saves += chunk.toString().split('\n').length - 1));
        proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));

        // On attend qu'au moins un enregistrement ait abouti, puis qu'un fichier temporaire soit en cours d'écriture.
        const deadline = Date.now() + 30_000;
        const before = new Set((await readdir(docDir)).filter(isTemp));
        for (;;) {
          if (proc.exitCode !== null) throw new Error(`L'écrivain s'est arrêté seul : ${stderr}`);
          if (Date.now() > deadline) throw new Error(`Aucune écriture observée : ${stderr}`);
          if (saves > 0 && (await readdir(docDir)).some((name) => isTemp(name) && !before.has(name))) break;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        proc.kill('SIGKILL');
        await exited;

        const leftovers = (await readdir(docDir)).filter((name) => isTemp(name) && !before.has(name));
        if (leftovers.length) interruptedMidWrite++;
        const result = validateDocument(JSON.parse(await readFile(file, 'utf8')));
        expect(result.ok, `essai ${run + 1}`).toBe(true);
        if (result.ok) expect(['Version A', 'Version B']).toContain(result.doc.name);
      }
      // Le processus a bien été tué avec une écriture entamée (fichier temporaire resté en plan).
      expect(interruptedMidWrite).toBeGreaterThan(0);

      // Le serveur relit le document intact malgré les restes, et les nettoie à l'ouverture suivante.
      const server = await startServer({ dev: true, hmr: false, port: 0, documentsDir: dir });
      try {
        expect((await fetch(`${server.url}/api/doc/essai`)).status).toBe(200);
        const temps = (await readdir(docDir)).filter(isTemp);
        expect(temps.length).toBeGreaterThan(0);
        // Un fichier temporaire récent peut appartenir à une écriture en cours : seuls les anciens sont supprimés.
        const old = new Date(Date.now() - 5 * 60_000);
        for (const name of temps) await utimes(path.join(docDir, name), old, old);
        const fresh = 'document.json.4242-0123abcd.tmp';
        await writeFile(path.join(docDir, fresh), '{"version": 2, "id": "ess');
        expect((await fetch(`${server.url}/api/doc/essai?open=1`)).status).toBe(200);
        expect((await readdir(docDir)).filter(isTemp)).toEqual([fresh]);
      } finally {
        await server.close();
      }
    });
  });

  it('PUT réessaie quand Windows tient document.json ouvert, et sérialise les écritures simultanées', async () => {
    await withServer(async ({ url, dir }) => {
      const file = await seedDocument(dir, docWithId('essai'));

      // Sous Windows, un lecteur (antivirus, indexeur) qui tient le fichier fait échouer le renommage (EPERM).
      const reader = await open(file, 'r');
      const started = Date.now();
      const pending = putJson(`${url}/api/doc/essai`, docWithId('essai', 'Pendant la lecture'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await reader.close();
      const res = await pending;
      expect(res.status).toBe(200);
      if (process.platform === 'win32') expect(Date.now() - started).toBeGreaterThanOrEqual(180);
      expect(JSON.parse(await readFile(file, 'utf8')).name).toBe('Pendant la lecture');

      const names = Array.from({ length: 12 }, (_, i) => `Version ${i}`);
      const results = await Promise.all(names.map((name) => putJson(`${url}/api/doc/essai`, docWithId('essai', name))));
      expect(results.map((r) => r.status)).toEqual(names.map(() => 200));
      const saved = validateDocument(JSON.parse(await readFile(file, 'utf8')));
      expect(saved.ok).toBe(true);
      if (saved.ok) expect(names).toContain(saved.doc.name);
      expect(await readdir(path.join(dir, 'essai'))).toEqual(['document.json']);
    });
  });

  it('le dernier enregistrement reçu gagne, même lancé dans la même milliseconde que les précédents', async () => {
    await withTempDocuments(async (dir) => {
      const file = await seedDocument(dir, docWithId('essai'));
      // Un `await mkdir` pris avant la file d'attente laissait passer B avant A environ une fois sur 200.
      for (let round = 0; round < 150; round++) {
        const names = ['v0', 'v1', 'v2'].map((v) => `${v}-${round}`);
        await Promise.all(names.map((name) => saveDocument(dir, 'essai', docWithId('essai', name))));
        expect(JSON.parse(await readFile(file, 'utf8')).name, `tour ${round}`).toBe(names[2]);
      }
    });
  });

  it(`?open=1 fait une copie horodatée dans history/ et n'en garde que ${HISTORY_LIMIT}`, async () => {
    await withServer(async ({ url, dir }) => {
      const file = await seedDocument(dir, docWithId('essai', 'Version 0'));
      const historyDir = path.join(dir, 'essai', 'history');
      const history = async () => (existsSync(historyDir) ? (await readdir(historyDir)).sort() : []);

      // Une simple lecture (aperçu, export) ne crée pas de copie.
      await fetch(`${url}/api/doc/essai`);
      expect(await history()).toEqual([]);

      expect((await fetch(`${url}/api/doc/essai?open=1`)).status).toBe(200);
      let copies = await history();
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?\.json$/);
      expect(await readFile(path.join(historyDir, copies[0]), 'utf8')).toBe(await readFile(file, 'utf8'));

      // Rouvrir sans rien changer n'ajoute pas de doublon (dix rechargements ne chassent pas dix vrais états).
      await fetch(`${url}/api/doc/essai?open=1`);
      expect(await history()).toHaveLength(1);

      const total = HISTORY_LIMIT + 5;
      for (let i = 1; i < total; i++) {
        expect((await putJson(`${url}/api/doc/essai`, docWithId('essai', `Version ${i}`))).status).toBe(200);
        expect((await fetch(`${url}/api/doc/essai?open=1`)).status).toBe(200);
      }
      copies = await history();
      expect(copies).toHaveLength(HISTORY_LIMIT);
      const names = await Promise.all(copies.map(async (name) => JSON.parse(await readFile(path.join(historyDir, name), 'utf8')).name));
      // Les plus anciennes ont été supprimées, les plus récentes gardées dans l'ordre.
      expect(names).toEqual(Array.from({ length: HISTORY_LIMIT }, (_, i) => `Version ${total - HISTORY_LIMIT + i}`));
    });
  });

  it('POST /api/assets range une photo JPEG de 40 Mo en moins de 5 s, aperçu de moins de 1 Mo', async () => {
    // Photo 8000 × 6000 bruitée, compressée en haute qualité : le bruit empêche JPEG de la réduire.
    const width = 8000;
    const height = 6000;
    const pixels = Buffer.alloc(width * height * 3);
    randomFillSync(pixels);
    for (let y = 0; y < height; y++) {
      const row = y * width * 3;
      const shade = Math.floor((y / height) * 160);
      for (let x = 0; x < width; x++) {
        const i = row + x * 3;
        pixels[i] = (pixels[i] >> 2) + shade;
        pixels[i + 1] = (pixels[i + 1] >> 2) + Math.floor((x / width) * 160);
        pixels[i + 2] = (pixels[i + 2] >> 2) + 60;
      }
    }
    const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
    expect(jpeg.length).toBeGreaterThanOrEqual(40_000_000);

    await withServer(async ({ url, dir }) => {
      await seedDocument(dir, docWithId('essai'));
      const started = Date.now();
      const res = await upload(url, 'essai', jpeg, 'Photo Plage été.JPG', 'image/jpeg');
      const elapsed = Date.now() - started;
      expect(res.status).toBe(201);
      expect(elapsed).toBeLessThan(5000);

      const asset = (await res.json()) as Asset;
      expect(asset).toMatchObject({
        kind: 'image',
        name: 'Photo Plage été.JPG',
        original: 'assets/originals/photo-plage-ete.jpg',
        preview: 'assets/previews/photo-plage-ete.webp',
        width,
        height,
      });
      expect(asset.id).toMatch(/^img-[0-9a-f]{12}$/);

      const docDir = path.join(dir, 'essai');
      const original = await readFile(path.join(docDir, asset.original));
      expect(sha1(original)).toBe(sha1(jpeg));
      const preview = await readFile(path.join(docDir, asset.preview!));
      expect(preview.length).toBeLessThan(1_000_000);
      const meta = await sharp(preview).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2000);
      expect(meta.width! / meta.height!).toBeCloseTo(width / height, 2);

      // Aucun reste de réception dans originals/.
      expect(await readdir(path.join(docDir, 'assets', 'originals'))).toEqual(['photo-plage-ete.jpg']);

      const served = await fetch(`${url}/api/assets/essai/${asset.preview}`);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/webp');
      expect(Buffer.from(await served.arrayBuffer()).length).toBe(preview.length);
      expect((await fetch(`${url}/api/assets/essai/assets/previews/absente.webp`)).status).toBe(404);
    });
  });

  it("un aperçu d'image très détaillée reste sous 1 Mo", async () => {
    // Bruit pur de 2000 px : environ 3 Mo en WebP à qualité normale.
    const noise = Buffer.alloc(2000 * 2000 * 3);
    randomFillSync(noise);
    const png = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
    await withServer(async ({ url, dir }) => {
      await seedDocument(dir, docWithId('essai'));
      const res = await upload(url, 'essai', png, 'bruit.png', 'image/png');
      expect(res.status).toBe(201);
      const asset = (await res.json()) as Asset;
      expect(asset).toMatchObject({ width: 2000, height: 2000, original: 'assets/originals/bruit.png' });
      expect((await stat(path.join(dir, 'essai', asset.preview!))).size).toBeLessThan(1_000_000);
    });
  });

  it("tient compte de l'orientation EXIF, convertit les profils en sRGB, accepte PNG, TIFF et WebP", async () => {
    await withServer(async ({ url, dir }) => {
      await seedDocument(dir, docWithId('essai'));
      const docDir = path.join(dir, 'essai');
      const send = async (data: Buffer, filename: string, type: string) => {
        const res = await upload(url, 'essai', data, filename, type);
        expect(res.status, filename).toBe(201);
        const asset = (await res.json()) as Asset;
        // Lu en mémoire : un fichier ouvert par sharp resterait verrouillé sous Windows et bloquerait le nettoyage.
        return { asset, preview: await readFile(path.join(docDir, asset.preview!)) };
      };

      // Photo de portrait prise appareil couché : stockée 300 × 200, affichée 200 × 300.
      const rotated = await solid(300, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer();
      const portrait = await send(rotated, 'portrait.jpg', 'image/jpeg');
      expect([portrait.asset.width, portrait.asset.height]).toEqual([200, 300]);
      const portraitMeta = await sharp(portrait.preview).metadata();
      expect([portraitMeta.width, portraitMeta.height]).toEqual([200, 300]);

      // Profil Display P3 incorporé : les valeurs stockées diffèrent du rouge voulu, l'aperçu sRGB le retrouve.
      const p3 = await solid(40, 30).withIccProfile('p3').jpeg({ quality: 100 }).toBuffer();
      const stored = await pixel(await sharp(p3, { ignoreIcc: true }).png().toBuffer());
      expect(Math.max(...stored.map((v, i) => Math.abs(v - [220, 30, 40][i])))).toBeGreaterThan(8);
      const fromP3 = await pixel((await send(p3, 'p3.jpg', 'image/jpeg')).preview);
      fromP3.forEach((v, i) => expect(Math.abs(v - [220, 30, 40][i])).toBeLessThanOrEqual(4));

      // Photo CMJN (fichier préparé pour l'imprimeur) : aperçu en RVB, rouge conservé à peu près.
      const cmyk = await solid(40, 30).withIccProfile('cmyk').toColourspace('cmyk').jpeg().toBuffer();
      const fromCmyk = await send(cmyk, 'cmjn.jpg', 'image/jpeg');
      const cmykMeta = await sharp(fromCmyk.preview).metadata();
      expect(cmykMeta.channels).toBe(3);
      const [r, g, b] = await pixel(fromCmyk.preview);
      expect(r).toBeGreaterThan(180);
      expect(g).toBeLessThan(80);
      expect(b).toBeLessThan(80);

      const sixteenBits = await solid(40, 30).toColourspace('rgb16').png().toBuffer();
      expect((await send(sixteenBits, 'seize-bits.png', 'image/png')).asset.original).toBe('assets/originals/seize-bits.png');
      const tiff = await send(await solid(40, 30).tiff().toBuffer(), 'scan.tiff', 'image/tiff');
      expect(tiff.asset.original).toBe('assets/originals/scan.tiff');
      expect(tiff.asset.preview).toBe('assets/previews/scan.webp');
      // Chrome ne décode pas le TIFF : une copie PNG pleine résolution sert à l'impression.
      expect(tiff.asset.print).toBe('assets/print/scan.png');
      const printMeta = await sharp(await readFile(path.join(docDir, tiff.asset.print!))).metadata();
      expect([printMeta.format, printMeta.width, printMeta.height]).toEqual(['png', 40, 30]);
      expect(await pixel(await readFile(path.join(docDir, tiff.asset.print!)))).toEqual([220, 30, 40]);
      expect(portrait.asset.print).toBeUndefined();
      await send(await solid(40, 30).webp().toBuffer(), 'image.webp', 'image/webp');
    });
  });

  it('donne un nom sûr et sans collision à chaque original', async () => {
    await withServer(async ({ url, dir }) => {
      await seedDocument(dir, docWithId('essai'));
      const jpeg = await solid(40, 30).jpeg().toBuffer();
      const results = await Promise.all(Array.from({ length: 4 }, () => upload(url, 'essai', jpeg, 'photo.jpg', 'image/jpeg')));
      const assets = (await Promise.all(results.map((r) => r.json()))) as Asset[];
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(assets.map((a) => a.original).sort()).toEqual(
        ['photo.jpg', 'photo-2.jpg', 'photo-3.jpg', 'photo-4.jpg'].map((n) => `assets/originals/${n}`).sort(),
      );
      expect(new Set(assets.map((a) => a.preview)).size).toBe(4);
      expect(new Set(assets.map((a) => a.id)).size).toBe(4);

      // Nom venu d'ailleurs (chemin complet, remontée, nom réservé Windows) : rangé dans originals/.
      const evil = await upload(url, 'essai', jpeg, '..\\..\\..\\evil.jpg', 'image/jpeg');
      expect(evil.status).toBe(201);
      expect(((await evil.json()) as Asset).original).toBe('assets/originals/evil.jpg');
      const reserved = await upload(url, 'essai', jpeg, 'NUL.jpg', 'image/jpeg');
      expect(((await reserved.json()) as Asset).original).toBe('assets/originals/image-nul.jpg');
      expect((await readdir(dir)).sort()).toEqual(['essai']);
      expect((await readdir(path.join(dir, 'essai'))).sort()).toEqual(['assets', 'document.json']);
    });
  });

  it('refuse un type de fichier autre que JPG, PNG, TIFF, WebP (415)', async () => {
    await withServer(async ({ url, dir }) => {
      await seedDocument(dir, docWithId('essai'));
      const originals = path.join(dir, 'essai', 'assets', 'originals');
      const leftovers = async () => (existsSync(originals) ? await readdir(originals) : []);

      const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
      let res = await upload(url, 'essai', pdf, 'plaquette.pdf', 'application/pdf');
      expect(res.status).toBe(415);
      expect((await res.json()).error).toMatch(/JPG, PNG, TIFF ou WebP/);

      // Le contenu décide, pas le nom : un GIF renommé en .jpg est refusé.
      const gif = await solid(20, 20).gif().toBuffer();
      expect((await upload(url, 'essai', gif, 'anime.jpg', 'image/jpeg')).status).toBe(415);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
      expect((await upload(url, 'essai', svg, 'logo.svg', 'image/svg+xml')).status).toBe(415);
      expect((await upload(url, 'essai', Buffer.from('pas une image'), 'faux.png', 'image/png')).status).toBe(415);

      res = await fetch(`${url}/api/assets/essai`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(415);
      expect(await leftovers()).toEqual([]);

      // Au-delà de la limite générale des requêtes (50 Mo), l'envoi n'est pas coupé : il est analysé, puis refusé.
      const big = Buffer.alloc(60 * 1024 * 1024);
      randomFillSync(big);
      expect((await upload(url, 'essai', big, 'grosse.jpg', 'image/jpeg')).status).toBe(415);
      expect(await leftovers()).toEqual([]);

      expect((await upload(url, 'essai-absent', pdf, 'photo.jpg', 'image/jpeg')).status).toBe(404);
    });
  });

  it('refuse un fichier plus lourd que la limite (413) sans rien laisser sur le disque', async () => {
    await withTempDocuments(async (dir) => {
      await seedDocument(dir, docWithId('essai'));
      const app = Fastify();
      await registerApiRoutes(app, { documentsDir: dir, maxUploadBytes: 1024 * 1024 });
      try {
        const noise = Buffer.alloc(1200 * 1200 * 3);
        randomFillSync(noise);
        const png = await sharp(noise, { raw: { width: 1200, height: 1200, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
        expect(png.length).toBeGreaterThan(1024 * 1024);
        const { contentType, payload } = await multipartBody(png, 'lourde.png', 'image/png');
        const res = await app.inject({ method: 'POST', url: '/api/assets/essai', headers: { 'content-type': contentType }, payload });
        expect(res.statusCode).toBe(413);
        expect(res.json().error).toMatch(/1 Mo/);
        expect(await readdir(path.join(dir, 'essai', 'assets', 'originals'))).toEqual([]);
        expect(await readdir(path.join(dir, 'essai', 'assets', 'previews'))).toEqual([]);
      } finally {
        await app.close();
      }
    });
  });

  it('refuse (400) tout identifiant ou chemin qui sortirait du dossier documents', async () => {
    await withServer(async ({ url, dir }) => {
      await seedDocument(dir, docWithId('essai'));
      await writeFile(path.join(dir, 'secret.txt'), 'ne doit jamais sortir');
      const photo = await multipartBody(await solid(20, 20).jpeg().toBuffer(), 'photo.jpg', 'image/jpeg');
      const json = { contentType: 'application/json', payload: Buffer.from(JSON.stringify(docWithId('essai'))) };

      for (const id of ['..', '%2e%2e', '..%2F..%2Fwindows', '..%5C..%5Cwindows', 'essai%2F..%2F..', 'C%3A%5CWindows', 'Essai', '.git']) {
        expect((await rawRequest(url, 'GET', `/api/doc/${id}`)).status, `GET ${id}`).toBe(400);
        expect((await rawRequest(url, 'GET', `/api/doc/${id}?open=1`)).status, `GET ${id}?open=1`).toBe(400);
        expect((await rawRequest(url, 'PUT', `/api/doc/${id}`, json)).status, `PUT ${id}`).toBe(400);
        expect((await rawRequest(url, 'POST', `/api/assets/${id}`, photo)).status, `POST ${id}`).toBe(400);
      }
      expect((await readdir(dir)).sort()).toEqual(['essai', 'secret.txt']);
      expect(existsSync(path.join(dir, 'essai', 'assets'))).toBe(false);

      for (const file of [
        '../document.json',
        'assets/../../secret.txt',
        'assets/../../../secret.txt',
        '..%2F..%2Fsecret.txt',
        'assets%2F..%2F..%2Fsecret.txt',
        'assets\\..\\..\\secret.txt',
        'C:%5CWindows%5Cwin.ini',
        'document.json',
      ]) {
        const res = await rawRequest(url, 'GET', `/api/assets/essai/${file}`);
        expect(res.status, file).toBe(400);
        expect(res.body).not.toContain('ne doit jamais sortir');
      }
    });
  });
});
