/**
 * Lot 113T (Trello #718) — exports JSON du BO récupérables sur iPhone :
 * lecture contrôlée (`fetchExportFile`) et remise du FICHIER (`deliverFile`).
 *
 *   L113T-U01  nom de fichier : type + identifiant utile + date, sûr pour les FS
 *   L113T-U02  Content-Disposition : filename* UTF-8, filename, chemins neutralisés
 *   L113T-U03  statut non OK → erreur typée, aucun fichier (401 renouvelé une fois)
 *   L113T-U04  mauvais Content-Type / JSON tronqué → INVALID_RESPONSE, aucun fichier
 *   L113T-U05  réponse valide → Blob JSON identique, nom du serveur
 *   L113T-U06  choix du canal : app native / Web Share (tactile + canShare) / téléchargement
 *   L113T-U07  app native : fichier écrit dans le cache puis feuille de partage AVEC le fichier
 *   L113T-U08  annulation (AbortError, « Share canceled ») → cancelled, sans erreur ni téléchargement
 *   L113T-U09  canShare faux / partage refusé → téléchargement ; NotAllowedError → nouveau geste
 *   L113T-U10  boutons du BO branchés sur le parcours commun (plus de lien vers l'API)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ExportError, EXPORT_MESSAGES, chooseDeliveryChannel, deliverFile, fetchExportFile, NATIVE_EXPORT_DIR, type DeliveryEnv,
} from '../export-delivery';
import { exportDateStamp, exportFileName, exportIdSlug, fileNameFromDisposition } from '../export-file-name';

const AT = new Date('2026-11-06T21:24:00Z'); // 22:24 à Paris
const EXEC = 'T1:ef883f80-e565-4bd3-a524-340c324205f8';

describe('L113T-U01 — nom de fichier', () => {
  it('type + identifiant utile + jour Europe/Paris', () => {
    expect(exportFileName('execution', EXEC, AT)).toBe('verebona-execution-T1-ef883f80-2026-11-06.json');
    expect(exportFileName('execution', EXEC, AT, { variant: 'avec-echanges' })).toBe('verebona-execution-T1-ef883f80-avec-echanges-2026-11-06.json');
    expect(exportFileName('execution-ia-appel', 2622, AT)).toBe('verebona-execution-ia-appel-2622-2026-11-06.json');
    expect(exportFileName('reconciliation-tarifs-ia', null, AT, { ext: 'csv' })).toBe('verebona-reconciliation-tarifs-ia-2026-11-06.csv');
    // 23 h 30 UTC le 06/11 = 00 h 30 le 07/11 à Paris.
    expect(exportDateStamp(new Date('2026-11-06T23:30:00Z'))).toBe('2026-11-07');
  });
  it('sûr pour Windows / macOS / iOS : aucun « : / \\ * ? " < > | », pas de point initial', () => {
    expect(exportIdSlug('T1:job:42')).toBe('T1-job-42');
    expect(exportIdSlug('T6E:12:1730900000000')).toBe('T6E-12-1730900000000');
    const n = exportFileName('../é tr:ange', 'a/b\\c*?"<>|:d', AT);
    expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(n).not.toMatch(/\.\./);
    expect(n.endsWith('.json')).toBe(true);
    expect(exportFileName('x', 'z'.repeat(500), AT).length).toBeLessThan(160);
  });
});

describe('L113T-U02 — nom lu dans Content-Disposition', () => {
  it('filename* UTF-8 prioritaire, sinon filename ; chemins et caractères interdits neutralisés', () => {
    expect(fileNameFromDisposition(`attachment; filename="verebona-execution-T1-ef883f80-2026-11-06.json"; filename*=UTF-8''verebona-execution-T1-ef883f80-2026-11-06.json`))
      .toBe('verebona-execution-T1-ef883f80-2026-11-06.json');
    expect(fileNameFromDisposition('attachment; filename="rapport-t1-5-2026-11-06-10-00-00.json"')).toBe('rapport-t1-5-2026-11-06-10-00-00.json');
    expect(fileNameFromDisposition('attachment; filename="../../etc/passwd.json"')).toBe('passwd.json');
    expect(fileNameFromDisposition(null)).toBeNull();
    expect(fileNameFromDisposition('inline')).toBeNull();
  });
});

const json = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers } });

describe('L113T-U03 — statut non OK : erreur claire, jamais de fichier', () => {
  const cas: Array<[number, string, string]> = [
    [403, 'FORBIDDEN', 'Contenus des échanges IA réservés aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).'],
    [404, 'NOT_FOUND', 'Exécution introuvable ou non déterminable.'],
    [500, 'SERVER_ERROR', EXPORT_MESSAGES.SERVER_ERROR],
    [502, 'SERVER_ERROR', EXPORT_MESSAGES.SERVER_ERROR],
  ];
  for (const [status, code, message] of cas) {
    it(`${status} → ${code}`, async () => {
      const f = vi.fn(async () => json({ error: code, message }, { status }));
      const err = await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: f as never, refresh: async () => true }).catch((e) => e);
      expect(err).toBeInstanceOf(ExportError);
      expect(err.code).toBe(code);
      expect(err.message).toBe(message);
      expect(err.status).toBe(status);
    });
  }
  it('401 : session renouvelée UNE fois puis relue ; sinon SESSION_EXPIRED', async () => {
    const ok = { format: 'verebona.ai-business-execution/1' };
    const f = vi.fn().mockResolvedValueOnce(json({ error: 'AUTH_REQUIRED' }, { status: 401 })).mockResolvedValueOnce(json(ok));
    const r = await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: f, refresh: async () => true });
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await r.blob.text())).toEqual(ok);

    const g = vi.fn(async () => json({ error: 'AUTH_REQUIRED' }, { status: 401 }));
    const refresh = vi.fn(async () => false);
    const err = await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: g as never, refresh }).catch((e) => e);
    expect(err.code).toBe('SESSION_EXPIRED');
    expect(err.message).toBe(EXPORT_MESSAGES.SESSION_EXPIRED);
    expect(g).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Renouvelée mais toujours refusée : pas de boucle.
    const h = vi.fn(async () => json({ error: 'AUTH_REQUIRED' }, { status: 401 }));
    expect((await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: h as never, refresh: async () => true }).catch((e) => e)).code).toBe('SESSION_EXPIRED');
    expect(h).toHaveBeenCalledTimes(2);
  });
  it('requête authentifiée par cookie (credentials include), sans jeton dans l’URL ; panne réseau → NETWORK', async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => json({ a: 1 }));
    await fetchExportFile('/api/admin/ai/business-executions/T1%3Aabc/export?download=1', { fallbackName: 'x.json' }, { fetch: f as never });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/admin/ai/business-executions/T1%3Aabc/export?download=1');
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
    const n = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect((await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: n as never }).catch((e) => e)).code).toBe('NETWORK');
    const a = vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    expect((await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: a as never }).catch((e) => e)).code).toBe('ABORTED');
  });
});

describe('L113T-U04 — mauvais Content-Type ou contenu tronqué : aucun faux fichier JSON', () => {
  it('page HTML (proxy, page d’erreur) → INVALID_RESPONSE', async () => {
    const f = async () => new Response('<!doctype html><title>502</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    const err = await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: f as never }).catch((e) => e);
    expect(err.code).toBe('INVALID_RESPONSE');
  });
  it('page de connexion après redirection → SESSION_EXPIRED', async () => {
    const r = new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(r, 'redirected', { value: true });
    Object.defineProperty(r, 'url', { value: 'https://app.test/login?redirect=%2Fadmin' });
    expect((await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: (async () => r) as never }).catch((e) => e)).code).toBe('SESSION_EXPIRED');
  });
  it('JSON tronqué → INVALID_RESPONSE ; CSV attendu mais JSON reçu → INVALID_RESPONSE', async () => {
    const f = async () => json('{"format":"verebona.ai-business-execution/1","calls":[');
    expect((await fetchExportFile('/api/x', { fallbackName: 'x.json' }, { fetch: f as never }).catch((e) => e)).code).toBe('INVALID_RESPONSE');
    const g = async () => json({ a: 1 });
    expect((await fetchExportFile('/api/x', { kind: 'csv', fallbackName: 'x.csv' }, { fetch: g as never }).catch((e) => e)).code).toBe('INVALID_RESPONSE');
  });
});

describe('L113T-U05 — réponse valide', () => {
  it('Blob application/json identique au corps, nom du serveur (sinon repli), extension garantie', async () => {
    const corps = `${JSON.stringify({ format: 'verebona.ai-business-execution/1', execution: { id: EXEC } }, null, 2)}\n`;
    const f = async () => json(corps, { headers: { 'content-disposition': `attachment; filename="v.json"; filename*=UTF-8''verebona-execution-T1-ef883f80-2026-11-06.json` } });
    const r = await fetchExportFile('/api/x', { fallbackName: 'repli.json' }, { fetch: f as never });
    expect(r.fileName).toBe('verebona-execution-T1-ef883f80-2026-11-06.json');
    expect(r.blob.type).toBe('application/json');
    expect(await r.blob.text()).toBe(corps);
    expect(r.bytes).toBe(Buffer.byteLength(corps));
    const g = async () => json({ a: 1 });
    expect((await fetchExportFile('/api/x', { fallbackName: 'verebona-execution-ia-appel-12-2026-11-06' }, { fetch: g as never })).fileName)
      .toBe('verebona-execution-ia-appel-12-2026-11-06.json');
    const c = async () => new Response('a;b\n1;2\n', { headers: { 'content-type': 'text/csv; charset=utf-8' } });
    expect((await fetchExportFile('/api/x', { kind: 'csv', fallbackName: 'r.csv' }, { fetch: c as never })).fileName).toBe('r.csv');
  });
});

function env(over: Partial<DeliveryEnv> = {}): DeliveryEnv & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    isNative: false, nativeFiles: null, nativeShare: null, webShare: null, webCanShare: null, touch: false,
    download: (_b, n) => { downloads.push(n); },
    ...over,
    downloads,
  } as DeliveryEnv & { downloads: string[] };
}
const blob = () => new Blob(['{"a":1}\n'], { type: 'application/json' });
const NAME = 'verebona-execution-T1-ef883f80-2026-11-06.json';

describe('L113T-U06 — choix du canal', () => {
  const file = new File([blob()], NAME, { type: 'application/json' });
  it('app native : plugins Filesystem + Share → partage natif ; plugin absent → indisponible (jamais de lien blob dans la vue)', () => {
    expect(chooseDeliveryChannel(file, env({ isNative: true, nativeFiles: { writeFile: async () => ({ uri: 'file:///x' }) }, nativeShare: { share: async () => ({}) } }))).toBe('native-share');
    expect(chooseDeliveryChannel(file, env({ isNative: true, nativeShare: { share: async () => ({}) } }))).toBe('unavailable');
  });
  it('navigateur tactile + canShare({ files }) vrai → Web Share ; faux, ordinateur ou canShare absent → téléchargement', () => {
    const share = async () => undefined;
    expect(chooseDeliveryChannel(file, env({ touch: true, webShare: share, webCanShare: () => true }))).toBe('web-share');
    expect(chooseDeliveryChannel(file, env({ touch: true, webShare: share, webCanShare: () => false }))).toBe('download');
    expect(chooseDeliveryChannel(file, env({ touch: false, webShare: share, webCanShare: () => true }))).toBe('download');
    expect(chooseDeliveryChannel(file, env({ touch: true, webShare: share, webCanShare: null }))).toBe('download');
    expect(chooseDeliveryChannel(file, env({ touch: true, webShare: share, webCanShare: () => { throw new TypeError('x'); } }))).toBe('download');
  });
});

describe('L113T-U07 — app native : le FICHIER est partagé', () => {
  it('écrit dans le cache (UTF-8, dossier vidé avant), puis Share avec files: [uri] — aucune URL d’API', async () => {
    const writeFile = vi.fn(async (_o: Record<string, unknown>) => ({ uri: `file:///var/mobile/Caches/${NATIVE_EXPORT_DIR}/${NAME}` }));
    const rmdir = vi.fn(async () => undefined);
    const share = vi.fn(async (_o: Record<string, unknown>) => ({ activityType: 'com.apple.DocumentManagerUICore.SaveToFiles' }));
    const e = env({ isNative: true, nativeFiles: { writeFile, rmdir }, nativeShare: { share } });
    const r = await deliverFile(blob(), NAME, {}, e);
    expect(r).toEqual({ outcome: 'shared', channel: 'native-share' });
    expect(rmdir).toHaveBeenCalledWith({ path: NATIVE_EXPORT_DIR, directory: 'CACHE', recursive: true });
    expect(writeFile.mock.calls[0][0]).toEqual({ path: `${NATIVE_EXPORT_DIR}/${NAME}`, data: '{"a":1}\n', directory: 'CACHE', recursive: true, encoding: 'utf8' });
    expect(share.mock.calls[0][0]).toMatchObject({ files: [`file:///var/mobile/Caches/${NATIVE_EXPORT_DIR}/${NAME}`] });
    expect(share.mock.calls[0][0]).not.toHaveProperty('url');
    expect(e.downloads).toEqual([]);
  });
  it('fichier binaire : base64 sans encodage', async () => {
    const writeFile = vi.fn(async (_o: Record<string, unknown>) => ({ uri: 'file:///x.zip' }));
    await deliverFile(new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'application/zip' }), 'x.zip', {}, env({ isNative: true, nativeFiles: { writeFile }, nativeShare: { share: async () => ({}) } }));
    expect(writeFile.mock.calls[0][0]).toMatchObject({ data: Buffer.from([0, 1, 2, 255]).toString('base64') });
    expect(writeFile.mock.calls[0][0]).not.toHaveProperty('encoding');
  });
  it('écriture ou partage en échec → SHARE_FAILED (message clair) ; plugins absents → UNAVAILABLE', async () => {
    const ko = env({ isNative: true, nativeFiles: { writeFile: async () => { throw new Error('disk'); } }, nativeShare: { share: async () => ({}) } });
    expect((await deliverFile(blob(), NAME, {}, ko).catch((e) => e)).code).toBe('SHARE_FAILED');
    const ko2 = env({ isNative: true, nativeFiles: { writeFile: async () => ({ uri: 'file:///x' }) }, nativeShare: { share: async () => { throw new Error('Error sharing item'); } } });
    expect((await deliverFile(blob(), NAME, {}, ko2).catch((e) => e)).code).toBe('SHARE_FAILED');
    expect((await deliverFile(blob(), NAME, {}, env({ isNative: true })).catch((e) => e)).code).toBe('UNAVAILABLE');
    expect(ko.downloads).toEqual([]);
  });
});

describe('L113T-U08 — annulation de la feuille de partage', () => {
  it('natif « Share canceled » → cancelled, sans erreur', async () => {
    const e = env({ isNative: true, nativeFiles: { writeFile: async () => ({ uri: 'file:///x' }) }, nativeShare: { share: async () => { throw new Error('Share canceled'); } } });
    await expect(deliverFile(blob(), NAME, {}, e)).resolves.toEqual({ outcome: 'cancelled', channel: 'native-share' });
  });
  it('Web Share AbortError → cancelled, aucun téléchargement de repli', async () => {
    const e = env({ touch: true, webCanShare: () => true, webShare: async () => { throw Object.assign(new Error('Share canceled'), { name: 'AbortError' }); } });
    await expect(deliverFile(blob(), NAME, {}, e)).resolves.toEqual({ outcome: 'cancelled', channel: 'web-share' });
    expect(e.downloads).toEqual([]);
  });
});

describe('L113T-U09 — Web Share et téléchargement', () => {
  it('partage avec le fichier (nom et type conservés)', async () => {
    const webShare = vi.fn(async (_d: ShareData) => undefined);
    const e = env({ touch: true, webCanShare: () => true, webShare });
    await expect(deliverFile(blob(), NAME, {}, e)).resolves.toEqual({ outcome: 'shared', channel: 'web-share' });
    const f = webShare.mock.calls[0][0].files![0];
    expect(f.name).toBe(NAME);
    expect(f.type).toBe('application/json');
    expect(await f.text()).toBe('{"a":1}\n');
  });
  it('canShare faux → téléchargement du fichier', async () => {
    const e = env({ touch: true, webCanShare: () => false, webShare: async () => undefined });
    await expect(deliverFile(blob(), NAME, {}, e)).resolves.toEqual({ outcome: 'downloaded', channel: 'download' });
    expect(e.downloads).toEqual([NAME]);
  });
  it('NotAllowedError (geste expiré) → needs-gesture, ou téléchargement si demandé ; autre refus → téléchargement', async () => {
    const refus = (name: string) => async () => { throw Object.assign(new Error('x'), { name }); };
    const e = env({ touch: true, webCanShare: () => true, webShare: refus('NotAllowedError') });
    await expect(deliverFile(blob(), NAME, {}, e)).resolves.toEqual({ outcome: 'needs-gesture', channel: 'web-share' });
    expect(e.downloads).toEqual([]);
    await expect(deliverFile(blob(), NAME, { onNeedsGesture: 'download' }, e)).resolves.toEqual({ outcome: 'downloaded', channel: 'download' });
    const t = env({ touch: true, webCanShare: () => true, webShare: refus('DataError') });
    await expect(deliverFile(blob(), NAME, {}, t)).resolves.toEqual({ outcome: 'downloaded', channel: 'download' });
    expect(t.downloads).toEqual([NAME]);
  });
});

describe('L113T-U10 — boutons d’export JSON du BO sur le parcours commun', () => {
  const ROOT = join(__dirname, '../../../..');
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  it('exécution métier, appel IA, rapport d’exécution, réconciliation tarifaire, rattrapages, isolation, configuration, données du compte', () => {
    const detail = read('src/app/admin/ai-executions/_components/BusinessExecutionDetail.tsx');
    expect(detail).toMatch(/<ExportFileButton appearance="link" url=\{exportUrl\(false\)\}[^>]*testId="unit-export"/);
    expect(detail).toMatch(/<ExportFileButton appearance="link" url=\{exportUrl\(true\)\}[^>]*testId="unit-export-contents"/);
    expect(detail).not.toMatch(/<a href=\{exportUrl/);
    expect(read('src/app/admin/ai-executions/_components/CopyJson.tsx')).toMatch(/exportFileWithFeedback\(`\$\{exportUrl\(callId\)\}\?download=1`/);
    const rapport = read('src/app/admin/ai-executions/_components/ExecutionReportPanel.tsx');
    expect(rapport).toMatch(/<ExportFileButton url=\{`\/api\/admin\/ai\/execution-reports\/\$\{r\.id\}\/export\?download=1`\}/);
    expect(rapport).not.toMatch(/<a href=\{`\/api\/admin\/ai\/execution-reports/);
    const tarifs = read('src/app/admin/ai-provider/_components/PricingPanel.tsx');
    expect(tarifs).toMatch(/<ExportFileButton[^>]*label="Exporter \(JSON\)"/);
    expect(tarifs).not.toMatch(/<a [^>]*>Exporter \(JSON\)<\/a>/);
    expect(read('src/app/admin/exploitation/_components/BackfillsPanel.tsx')).toMatch(/exportFileWithFeedback\(`\/api\/admin\/ops\/backfills\/\$\{run\.id\}\/report`/);
    expect(read('src/app/admin/exploitation/_components/CrossAccountPanel.tsx')).toMatch(/saveFileWithFeedback\(/);
    expect(read('src/app/admin/ai-config/page.tsx')).toMatch(/await deliverFile\(new Blob\(\[r\.content\]/);
    expect(read('src/app/admin/accounts/[id]/_components/account-data/EntityDrawer.tsx')).toMatch(/await deliverFile\(blob, name/);
    expect(read('src/app/admin/accounts/[id]/_components/account-data/DossierView.tsx')).toMatch(/saveFileWithFeedback\(new Blob/);
    // Plus aucun lien <a download> fait main dans ces écrans.
    for (const f of [
      'src/app/admin/ai-executions/_components/CopyJson.tsx', 'src/app/admin/exploitation/_components/BackfillsPanel.tsx',
      'src/app/admin/exploitation/_components/CrossAccountPanel.tsx', 'src/app/admin/ai-config/page.tsx',
      'src/app/admin/accounts/[id]/_components/account-data/EntityDrawer.tsx', 'src/app/admin/accounts/[id]/_components/account-data/DossierView.tsx',
    ]) expect(read(f), f).not.toMatch(/\.download = /);
  });
  it('composant : « Préparation… », message d’échec affiché, aucune couleur brute', () => {
    const c = read('src/components/admin/ExportFileButton.tsx');
    expect(c).toContain("preparing: 'Préparation…'");
    expect(c).toMatch(/role="alert"/);
    const code = c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\b(?:bg|text|border)-(?:red|green|blue|gray|white|black)\b/i);
  });
  it('route d’exécution métier : nom type + identifiant + date, variante « avec échanges »', () => {
    const r = read('src/app/api/admin/ai/business-executions/[id]/export/route.ts');
    expect(r).toMatch(/exportFileName\('execution', id, new Date\(\), sensitive \? \{ variant: 'avec-echanges' \} : \{\}\)/);
  });
});
