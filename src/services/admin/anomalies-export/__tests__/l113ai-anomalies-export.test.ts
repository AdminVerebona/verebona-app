/**
 * Lot 113AI (Trello #733) — anomalies du BO copiables / exportables.
 *
 *   L113AI-U01  paramètres : mêmes filtres que l'écran, liste blanche stricte
 *   L113AI-U02  enregistrement : identifiants seulement, aucun nom / e-mail, liens BO
 *   L113AI-U03  masquage du détail : secrets, e-mails pseudonymisés, contenus, identité
 *   L113AI-U04  contexte technique : code, SQLSTATE, étape, version ; gravité jamais inventée
 *   L113AI-U05  dates : Europe/Paris (heure d'hiver / d'été) + ISO
 *   L113AI-U06  Markdown (une anomalie, la page) : champs, échappement, aucun e-mail
 *   L113AI-U07  CSV : BOM, `;`, guillemets, retours, formules neutralisées, colonnes alignées
 *   L113AI-U08  JSON versionné en flux : tête + éléments + fin = document valide
 *   L113AI-U09  flux serveur : lots par curseur, connexion rendue, interruption signalée
 *   L113AI-U10  câblage : garde admin, audit ANOMALY_EXPORT, écrans, SELECT sans nom ni e-mail
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fakeDb = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  released: 0,
  failFetchAt: -1,
}));

vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async () => []),
    reserve: vi.fn(async () => {
      let cursor = 0;
      let fetches = 0;
      return {
        unsafe: async (sql: string) => {
          fakeDb.calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
          if (/^SELECT count/.test(sql.trim())) return [{ n: fakeDb.rows.length, at: new Date('2026-11-10T16:00:00Z') }];
          const m = /^FETCH (\d+)/.exec(sql.trim());
          if (m) {
            if (fetches++ === fakeDb.failFetchAt) throw Object.assign(new Error('boom'), { code: '57014' });
            const out = fakeDb.rows.slice(cursor, cursor + Number(m[1]));
            cursor += out.length;
            return out;
          }
          return [];
        },
        release: () => { fakeDb.released++; },
      };
    }),
  },
  db: {},
}));

import {
  ANOMALY_CSV_COLUMNS, ANOMALY_CSV_HEADER, ANOMALY_EXPORT_FORMAT, anomalyCsvLine, anomalyExportFileName, anomalyJsonHead, anomalyJsonItem,
  anomalyJsonTail, extractTechnicalContext, formatAnomalyListMarkdown, formatAnomalyMarkdown, maskAnomalyDetail, mdInline,
  parisDateTime, parseAnomalyExportQuery, toExportRecord, type AnomalyExportSource,
} from '../model';

const root = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const sp = (o: Record<string, string>) => new URLSearchParams(o);
const EMAIL = 'jean.dupont@example.com';
const BASE = 'https://bo.verebona.test/';
const meta = {
  generatedAt: new Date('2026-11-10T16:05:03Z'),
  filters: { status: 'open' as const, sort: 'date' as const, dir: 'desc' as const },
  build: { version: '1.0.0', commit: 'abc1234' },
  baseUrl: BASE,
};

function source(over: Partial<AnomalyExportSource> = {}): AnomalyExportSource {
  return {
    id: 42, domain: 'other', domainLabel: 'Autres traitements techniques', fingerprint: 'other:coherence:coh-doc-targets',
    title: 'Cohérence COH-DOC-TARGETS : 3 objets', status: 'open', accountId: 7, userId: 11, occurrenceCount: 3,
    firstSeenAt: new Date('2026-01-15T08:00:00Z'), lastSeenAt: new Date('2026-07-15T08:00:00Z'), resolvedAt: null,
    resolutionSource: null, cause: null, correctiveAction: null, autoResolutionOrigin: null, autoResolutionCause: null,
    previousAnomalyId: null,
    technicalDetail: {
      checkId: 'COH-DOC-TARGETS', sqlstate: '23505', step: 'repair', version: 'v12', fileId: 387,
      error: `échec pour ${EMAIL} avec Bearer abcdefghijklmnop`, recipient_email: EMAIL, full_text: 'Contrat de bail de Jean Dupont…',
      excerpt: 'Loyer 850 €', accountName: 'Famille Dupont', nested: { api_key: 'sk_live_ABCDEFGH12345678', phone: '0601020304' },
    },
    ...over,
  };
}

describe('L113AI-U01 — paramètres', () => {
  it('défauts identiques à l’écran, valeurs inconnues refusées', () => {
    expect(parseAnomalyExportQuery(sp({}))).toEqual({ ok: true, value: { status: 'open', sort: 'date', dir: 'desc', format: 'json', page: 1 } });
    expect(parseAnomalyExportQuery(sp({ status: 'resolved', sort: 'domain', format: 'csv' }))).toMatchObject({ ok: true, value: { status: 'resolved', sort: 'domain', dir: 'asc', format: 'csv' } });
    expect(parseAnomalyExportQuery(sp({ format: 'md', page: '3', dir: 'asc' }))).toMatchObject({ ok: true, value: { format: 'md', page: 3, dir: 'asc' } });
    const bads: Array<Record<string, string>> = [{ status: 'all' }, { sort: 'id; DROP TABLE users' }, { dir: 'up' }, { format: 'xlsx' }, { page: '0' }, { page: 'x' }];
    for (const bad of bads) {
      expect(parseAnomalyExportQuery(sp(bad)).ok).toBe(false);
    }
    expect(parseAnomalyExportQuery(sp({ format: 'md' }), ['json', 'csv']).ok).toBe(false);
  });
  it('nom de fichier daté (jour civil Europe/Paris)', () => {
    expect(anomalyExportFileName('open', 'csv', new Date('2026-11-10T23:30:00Z'))).toBe('verebona-anomalies-ouvertes-2026-11-11.csv');
    expect(anomalyExportFileName('resolved', 'json', new Date('2026-11-10T12:00:00Z'))).toBe('verebona-anomalies-resolues-2026-11-10.json');
    expect(anomalyExportFileName('open', 'json', new Date('2026-11-10T12:00:00Z'), 42)).toBe('verebona-anomalie-42-2026-11-10.json');
  });
});

describe('L113AI-U02/U03 — enregistrement et masquage', () => {
  const r = toExportRecord(source(), BASE);
  const s = JSON.stringify(r);
  it('identifiants internes et liens BO, aucune donnée personnelle', () => {
    expect(r.compte).toEqual({ id: 7, lienBo: 'https://bo.verebona.test/admin/accounts/7' });
    expect(r.utilisateur).toEqual({ id: 11, lienBo: 'https://bo.verebona.test/admin/users/11' });
    expect(r.lienBo).toBe('https://bo.verebona.test/admin/supervision/42');
    expect(r.statut).toBe('ouverte');
    expect(r.resolution).toBeNull();
    expect(s).not.toContain(EMAIL);
    expect(s).not.toContain('Dupont');
    expect(s).not.toContain('sk_live_');
    expect(s).not.toContain('abcdefghijklmnop');
    expect(s).not.toContain('0601020304');
    expect(s).not.toContain('Loyer');
  });
  it('détail masqué mais exploitable (identifiants et codes conservés)', () => {
    const d = maskAnomalyDetail(source().technicalDetail) as Record<string, any>;
    expect(d.fileId).toBe(387);
    expect(d.checkId).toBe('COH-DOC-TARGETS');
    expect(d.recipient_email).toMatchObject({ $etat: 'masque', motif: 'e-mail' });
    expect(d.full_text.$etat).toBe('masque');
    expect(d.excerpt).toMatchObject({ $etat: 'masque', longueur: 11 });
    expect(d.accountName).toMatchObject({ $etat: 'masque', motif: 'identité' });
    expect(d.error).toMatch(/\[e-mail masqué #[0-9a-f]{8}\]/);
    expect(d.nested.api_key.$etat).toBe('masque');
    expect(maskAnomalyDetail(null)).toBeNull();
  });
  it('résolue : cause et action corrective masquées, source lisible', () => {
    const x = toExportRecord(source({ status: 'resolved', resolvedAt: new Date('2026-11-01T10:00:00Z'), resolutionSource: 'manual', cause: `écrit par ${EMAIL}`, correctiveAction: 'relance' }), BASE);
    expect(x.statut).toBe('resolue');
    expect(x.resolution).toMatchObject({ source: 'manuelle', actionCorrective: 'relance' });
    expect(x.resolution?.cause).not.toContain(EMAIL);
  });
});

describe('L113AI-U04 — contexte technique', () => {
  it('code, SQLSTATE, étape, version, traitement', () => {
    expect(extractTechnicalContext({ checkId: 'COH-X', sqlstate: '23505', step: 'repair', version: 'v3', treatment: 'T3' }))
      .toEqual({ code: 'COH-X', sqlstate: '23505', etape: 'repair', version: 'v3', traitement: 'T3' });
    expect(extractTechnicalContext({ code: '57014' }).sqlstate).toBe('57014');
    expect(extractTechnicalContext({ code: 'T3_DOCUMENT_ASSET_X' }).sqlstate).toBeNull();
    expect(extractTechnicalContext(null)).toEqual({ code: null, sqlstate: null, etape: null, version: null, traitement: null });
  });
  it('code de repli = empreinte ; gravité reprise ou déclarée non définie', () => {
    const a = toExportRecord(source({ technicalDetail: null, fingerprint: 'backups:database' }), BASE);
    expect(a.code).toBe('backups:database');
    expect(a.gravite).toBeNull();
    expect(a.graviteMotif).toMatch(/non définie/);
    expect(toExportRecord(source({ technicalDetail: { severity: 'error' } }), BASE).gravite).toBe('error');
  });
});

describe('L113AI-U05 — dates', () => {
  it('Europe/Paris en hiver (UTC+1) et en été (UTC+2), ISO conservé', () => {
    expect(parisDateTime(new Date('2026-01-15T08:00:00Z'))).toBe('15/01/2026 09:00:00');
    expect(parisDateTime(new Date('2026-07-15T08:00:00Z'))).toBe('15/07/2026 10:00:00');
    const r = toExportRecord(source(), BASE);
    expect(r.premiereOccurrence).toEqual({ iso: '2026-01-15T08:00:00.000Z', paris: '15/01/2026 09:00:00' });
  });
});

describe('L113AI-U06 — Markdown', () => {
  it('une anomalie : tous les champs utiles, prêt à coller', () => {
    const md = formatAnomalyMarkdown(toExportRecord(source(), BASE, [
      { id: 1, occurredAt: new Date('2026-07-15T08:00:00Z'), accountId: 7, userId: 11, technicalDetail: { to: EMAIL, code: 'X|Y' } },
    ]), meta);
    for (const t of ['## Anomalie #42', '- Code : COH-DOC-TARGETS', '- Gravité : non définie', '- Domaine : Autres traitements techniques (other)',
      '- Statut : ouverte', '- Compte : #7 (https://bo.verebona.test/admin/accounts/7)', '- Utilisateur : #11', '- Objet (empreinte) : other:coherence:coh-doc-targets',
      '- Première occurrence : 15/01/2026 09:00:00 (Europe/Paris) — 2026-01-15T08:00:00.000Z', '- Occurrences : 3', '- SQLSTATE : 23505', '- Étape : repair',
      '- Version (détail) : v12', 'commit abc1234', '- Lien BO : https://bo.verebona.test/admin/supervision/42', '```json', '### Historique des occurrences',
      ANOMALY_EXPORT_FORMAT]) expect(md).toContain(t);
    expect(md).not.toContain(EMAIL);
    expect(md).toContain('X\\|Y');
  });
  it('un accent grave ne referme pas le bloc de code', () => {
    const md = formatAnomalyMarkdown(toExportRecord(source({ technicalDetail: { error: 'a ``` b' } }), BASE), meta);
    expect(md.match(/```/g)).toHaveLength(2);
  });
  it('la page : en-tête des filtres, une ligne par anomalie, cellules sur une ligne', () => {
    const recs = [toExportRecord(source(), BASE), toExportRecord(source({ id: 43, title: 'ligne 1\nligne 2 | pipe' }), BASE)];
    const md = formatAnomalyListMarkdown(recs, { ...meta, page: 2, pageSize: 25, total: 60 });
    expect(md).toContain('statut ouvertes · tri date décroissant');
    expect(md).toContain('Page 2 / 3 : 2 anomalie(s) sur 60 au total');
    expect(md).toContain('| 43 |');
    expect(md).toContain('ligne 1 ligne 2 \\| pipe');
    expect(md).not.toContain(EMAIL);
    expect(mdInline(null)).toBe('—');
  });
});

describe('L113AI-U07 — CSV', () => {
  it('en-tête, séparateur, échappement et neutralisation des formules', () => {
    expect(ANOMALY_CSV_HEADER.startsWith('﻿id;code;gravite;')).toBe(true);
    expect(ANOMALY_CSV_HEADER.endsWith('\r\n')).toBe(true);
    const line = anomalyCsvLine(toExportRecord(source({ title: '=HYPERLINK("x");a\nb' }), BASE));
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line).toContain('"\'=HYPERLINK(""x"");a\nb"');
    expect(line).not.toContain(EMAIL);
    // Colonnes alignées : on relit la ligne avec un analyseur CSV minimal.
    const cells: string[] = [];
    let cur = ''; let q = false;
    const body = line.slice(0, -2);
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (q) { if (ch === '"' && body[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ';') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    expect(cells).toHaveLength(ANOMALY_CSV_COLUMNS.length);
    expect(cells[0]).toBe('42');
    expect(cells[ANOMALY_CSV_COLUMNS.indexOf('compte_id')]).toBe('7');
    expect(JSON.parse(cells[ANOMALY_CSV_COLUMNS.indexOf('detail_technique_json')]).fileId).toBe(387);
  });
});

describe('L113AI-U08 — JSON versionné', () => {
  it('tête + éléments + fin forment un document valide, complétude déclarée', () => {
    const recs = [toExportRecord(source(), BASE), toExportRecord(source({ id: 43 }), BASE)];
    const text = anomalyJsonHead({ ...meta, total: 2, snapshotAt: new Date('2026-11-10T16:00:00Z') }) + recs.map(anomalyJsonItem).join('') + anomalyJsonTail(2, 2);
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ format: 'verebona.bo-anomalies/2', schema: 'verebona.bo-anomalies', schemaVersion: 2, total: 2, exported: 2, complete: true, timeZone: 'Europe/Paris' });
    expect(doc.generatedAtParis).toBe('10/11/2026 17:05:03');
    expect(doc.filters).toEqual({ status: 'open', sort: 'date', dir: 'desc' });
    expect(doc.items.map((i: { id: number }) => i.id)).toEqual([42, 43]);
    expect(JSON.parse(anomalyJsonHead({ ...meta, total: 0, snapshotAt: new Date() }) + anomalyJsonTail(0, 0)).items).toEqual([]);
    expect(JSON.parse(anomalyJsonHead({ ...meta, total: 3, snapshotAt: new Date() }) + anomalyJsonTail(0, 3)).complete).toBe(false);
  });
});

describe('L113AI-U09 — flux serveur par curseur', () => {
  const raw = (id: number) => ({
    id, domain: 'ai', fingerprint: `ai:x:${id}`, title: `A${id}`, status: 'open', account_id: 7, user_id: null, occurrence_count: 1,
    first_seen_at: new Date('2026-11-01T00:00:00Z'), last_seen_at: new Date('2026-11-02T00:00:00Z'), resolved_at: null, resolution_source: null,
    cause: null, corrective_action: null, auto_resolution_origin: null, auto_resolution_cause: null, previous_anomaly_id: null,
    technical_detail: { email: EMAIL },
  });
  const drain = async (body: ReadableStream<Uint8Array>) => new Response(body).text();

  it('lit par lots, écrit tout, rend la connexion, signale l’issue', async () => {
    fakeDb.rows = Array.from({ length: 23 }, (_, i) => raw(i + 1));
    fakeDb.calls = []; fakeDb.released = 0; fakeDb.failFetchAt = -1;
    const { openAnomalyExportStream } = await import('../service');
    const batches: number[] = [];
    const done = vi.fn();
    const s = await openAnomalyExportStream({ status: 'open', sort: 'date', dir: 'desc', format: 'json', page: 1 }, { baseUrl: BASE, batchSize: 5, onBatch: (n) => batches.push(n), onDone: done });
    expect(s.total).toBe(23);
    const doc = JSON.parse(await drain(s.body));
    expect(doc.items).toHaveLength(23);
    expect(doc).toMatchObject({ exported: 23, complete: true });
    expect(batches).toEqual([5, 5, 5, 5, 3, 0]);
    expect(fakeDb.calls).toContain('BEGIN ISOLATION');
    expect(fakeDb.calls).toContain('DECLARE vb_anomaly_export');
    expect(fakeDb.released).toBe(1);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ exported: 23, total: 23, complete: true, error: null }));
    expect(JSON.stringify(doc)).not.toContain(EMAIL);
  });

  it('CSV : une ligne par anomalie après l’en-tête', async () => {
    fakeDb.rows = Array.from({ length: 7 }, (_, i) => raw(i + 1));
    fakeDb.released = 0; fakeDb.failFetchAt = -1;
    const { openAnomalyExportStream } = await import('../service');
    const s = await openAnomalyExportStream({ status: 'open', sort: 'date', dir: 'desc', format: 'csv', page: 1 }, { baseUrl: BASE, batchSize: 3 });
    const text = await drain(s.body);
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(8);
    expect(fakeDb.released).toBe(1);
  });

  it('erreur de lecture en cours de flux : réponse en erreur, issue incomplète, connexion rendue', async () => {
    fakeDb.rows = Array.from({ length: 12 }, (_, i) => raw(i + 1));
    fakeDb.released = 0; fakeDb.failFetchAt = 1;
    const { openAnomalyExportStream } = await import('../service');
    const done = vi.fn();
    const s = await openAnomalyExportStream({ status: 'open', sort: 'date', dir: 'desc', format: 'json', page: 1 }, { baseUrl: BASE, batchSize: 5, onDone: done });
    await expect(drain(s.body)).rejects.toThrow();
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ exported: 5, total: 12, complete: false, error: 'READ_TIMEOUT' }));
    expect(fakeDb.released).toBe(1);
  });

  it('départ du client : curseur fermé, issue CLIENT_ABORTED', async () => {
    fakeDb.rows = Array.from({ length: 12 }, (_, i) => raw(i + 1));
    fakeDb.released = 0; fakeDb.failFetchAt = -1;
    const { openAnomalyExportStream } = await import('../service');
    const done = vi.fn();
    const s = await openAnomalyExportStream({ status: 'open', sort: 'date', dir: 'desc', format: 'json', page: 1 }, { baseUrl: BASE, batchSize: 5, onDone: done });
    const reader = s.body.getReader();
    await reader.read();
    await reader.cancel();
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ complete: false, error: 'CLIENT_ABORTED' }));
    expect(fakeDb.released).toBe(1);
  });
});

describe('L113AI-U10 — câblage', () => {
  it('routes : garde administrateur avant toute lecture, audit ANOMALY_EXPORT, pas de cache', () => {
    for (const p of ['src/app/api/admin/anomalies/export/route.ts', 'src/app/api/admin/anomalies/[id]/export/route.ts']) {
      const src = read(p);
      expect((src.match(/\brequireAdmin\s*\(/g) ?? []).length).toBe((src.match(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g) ?? []).length);
      expect(src.indexOf('guardAdmin(')).toBeLessThan(src.indexOf('searchParams'));
      expect(src).toContain("action: 'ANOMALY_EXPORT'");
      expect(src).toContain('NO_STORE');
    }
    expect(read('src/lib/admin-audit.ts')).toContain("| 'ANOMALY_EXPORT'");
  });
  it('SELECT de l’export : ni nom de compte ni e-mail ; mêmes tri et jointures que l’écran', () => {
    const src = read('src/services/admin/anomalies-export/service.ts');
    const select = src.slice(src.indexOf('const EXPORT_SELECT'), src.indexOf('WHERE an.status = $1`;'));
    expect(select).not.toMatch(/acc\.name|u\.email/);
    expect(src).toContain('anomalyOrderBy(q.status, q.sort, q.dir)');
  });
  it('écrans : barre d’export sur les deux listes, copie sur l’écran de traitement, aucune couleur brute', () => {
    expect(read('src/app/admin/_dashboard/SupervisionTab.tsx')).toContain('<AnomalyListExportBar');
    expect(read('src/app/admin/supervision/[id]/page.tsx')).toContain('<AnomalyCopyButtons');
    const ui = read('src/app/admin/_dashboard/AnomalyExport.tsx');
    expect(ui).not.toMatch(/\[#[0-9a-fA-F]{3,8}\]|['"]#[0-9a-fA-F]{3,8}['"]|rgba?\(|\b(bg|text|border)-(red|green|blue|gray|slate|amber|yellow|orange)-\d{2,3}\b/);
    expect(ui).toContain('À VALIDER PAR LE PO');
  });
});
