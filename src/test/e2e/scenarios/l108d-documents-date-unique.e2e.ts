/**
 * Lot 108D — listes de documents : une seule date, la date du document,
 * sinon « – » (ticket P1), sur PostgreSQL 16 réel. Diagnostic SANS accès à
 * la préproduction : reproduction SYNTHÉTIQUE du chemin démontré par le code
 * (date du jour pré-remplie par la fenêtre d'ajout → `files/confirm` →
 * `asset_files.document_date`, T1 sans date lisible). Aucune règle propre à
 * un bien ou un véhicule : les libellés sont des exemples.
 *
 *   E2E-01  reprise du stock (COH-DOC-DATE-FALLBACK) : à blanc d'abord
 *           (mesure, aucune écriture), puis correctif — date T1 reposée,
 *           jour d'import retiré sans preuve, documents réellement datés du
 *           jour / corrigés à la main / anciens intacts, cas contesté ambigu ;
 *           journal avant / après ; second passage idempotent ;
 *   E2E-02  API des listes (`GET /api/v2/documents`) après reprise : une date
 *           documentaire par ligne (ou null → « – »), jamais la date d'ajout ;
 *           tri « Date du document » : sans date en fin dans les deux sens ;
 *           « Date d'ajout » toujours triable et filtrable, inchangée ;
 *   E2E-03  entrée d'un document (`POST /api/files/confirm`) : jour courant
 *           d'un ancien client ignoré ; date saisie (marque USER) posée et
 *           protégée — ni T1 (analyse qui lit une autre date) ni le contrôle
 *           de cohérence (date égale au jour d'import) ne l'écrasent ;
 *           T1 sans date lisible → la date reste vide.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import { proofOf, runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// Confirmation de dépôt : stockage, miniatures, crédit d'analyse et fusion hors périmètre.
vi.mock('@/lib/upload-object-check', () => ({ verificationObjetActive: () => false, verifierObjetDepose: async () => ({ kind: 'ok' }) }));
vi.mock('@/services/documents/thumbnails/thumbnail.service', async (o) => ({
  ...(await o<typeof import('@/services/documents/thumbnails/thumbnail.service')>()), enqueueThumbnails: () => undefined,
}));
vi.mock('@/services/commercial-model.service', async (o) => ({ ...(await o<object>()), canConsumeAnalysis: async () => ({ allowed: false }) }));
vi.mock('@/services/document-ai/fusion-detector', () => ({ detectFusionCandidates: async () => [] }));

const CHECK = 'COH-DOC-DATE-FALLBACK';
type Compte = { id: number; ownerUserId: number };
interface Ligne { document_date: string | null; uploaded_at: string; ue: Record<string, boolean> | null }

scenario('L108D', 'Listes de documents : une seule date, la date du document, sinon « – »', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  const as = (c: Compte) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const IMPORT = '2026-09-24 10:15:00+02';
  const JOUR_IMPORT = '2026-09-24';

  /** Document déposé le jour `IMPORT` (création et confirmation), avec sa date du document stockée. */
  const doc = async (c: Compte, o: { titre: string; date: string | null; type?: string; userEdited?: boolean }) => {
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, s3_key, s3_bucket, original_filename, filename, mime_type, retained_title,
                               document_type_code, rubric_code, document_date, user_edited_fields, uploaded_at, created_at, upload_status, analysis_state)
      VALUES (${c.ownerUserId}, ${c.id}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'e2e-bucket', ${`${o.titre}.pdf`}, ${`${o.titre}.pdf`},
              'application/pdf', ${o.titre}, ${o.type ?? 'INVOICE'}, 'MAINTENANCE_WORKS', ${o.date}::date,
              ${o.userEdited ? JSON.stringify({ documentDate: true }) : null}::jsonb, ${IMPORT}::timestamptz, ${IMPORT}::timestamptz, 'COMPLETED', 'ANALYZED')
      RETURNING id`;
    return f.id;
  };
  /** Connaissance T1 persistée (date lue + confiance), comme en fin d'analyse. */
  const connaissance = async (c: Compte, fileId: number, date: string | null, confidence = 'certain') => {
    await sql`INSERT INTO document_extractions (account_id, file_id, title, document_type_code, document_date, full_text, full_text_chars, structural_evidence)
              VALUES (${c.id}, ${fileId}, 'x', 'INVOICE', ${date}::date, '', 0,
                      ${JSON.stringify(date ? { documentDate: { confidence, excerpt: date, location: {} } } : {})}::jsonb)`;
  };
  const ligne = async (id: number) => (await sql<Ligne[]>`
    SELECT document_date::text AS document_date, uploaded_at::text AS uploaded_at, user_edited_fields AS ue FROM asset_files WHERE id = ${id}`)[0];
  const feed = async (c: Compte, qs: string) => {
    as(c);
    const { GET } = await import('@/app/api/v2/documents/route');
    const r = await GET(new NextRequest(`http://x/api/v2/documents?${qs}&limit=100`));
    expect(r.status).toBe(200);
    return (await r.json() as { documents: Array<{ id: number; documentDate: string | null; uploadedAt: string | null }> }).documents;
  };

  let moi: Compte;
  const ids: Record<string, number> = {};

  // ══ E2E-01 ═══════════════════════════════════════════════════════════════

  it('L108D-E2E-01 — reprise du stock : mesure à blanc, réparation prouvée seulement, journal, idempotence', async () => {
    moi = await make.account({ plan: 'premium' });
    // Facture de décembre 2025 importée le 24/09/2026 : jour d'import posé par repli, T1 avait lu 20/12/2025.
    ids.facture = await doc(moi, { titre: 'Facture entretien', date: JOUR_IMPORT });
    await connaissance(moi, ids.facture, '2025-12-20', 'probable');
    // Trois justificatifs anciens importés le même jour, correctement datés : intacts.
    ids.j2019 = await doc(moi, { titre: 'Rapport entretien 2019', date: '2019-10-22', type: 'MAINTENANCE_REPORT' });
    ids.j2020 = await doc(moi, { titre: 'Facture 2020', date: '2020-06-03' });
    ids.j2021 = await doc(moi, { titre: 'Certificat 2021', date: '2021-01-15', type: 'REGISTRATION_CERTIFICATE' });
    for (const [k, d] of [['j2019', '2019-10-22'], ['j2020', '2020-06-03'], ['j2021', '2021-01-15']] as const) await connaissance(moi, ids[k], d);
    // Jamais analysé, jour d'import sans aucune preuve : retiré (« – »).
    ids.sansPreuve = await doc(moi, { titre: 'Scan sans analyse', date: JOUR_IMPORT });
    // T1 n'a lu aucune date : retiré.
    ids.t1SansDate = await doc(moi, { titre: 'Photo ticket', date: JOUR_IMPORT });
    await connaissance(moi, ids.t1SansDate, null);
    // Document réellement daté du jour d'import (T1 l'a lu) : intact.
    ids.duJour = await doc(moi, { titre: 'Ticket du jour', date: JOUR_IMPORT });
    await connaissance(moi, ids.duJour, JOUR_IMPORT);
    // Correction manuelle égale au jour d'import : jamais touchée.
    ids.manuel = await doc(moi, { titre: 'Contrat signé', date: JOUR_IMPORT, userEdited: true });
    // T1 a lu le jour d'import comme date CONTESTÉE : ambigu, aucune écriture.
    ids.conteste = await doc(moi, { titre: 'Devis', date: JOUR_IMPORT });
    await connaissance(moi, ids.conteste, JOUR_IMPORT, 'conflictual');
    // Date d'ajout de référence.
    const ajout = (await ligne(ids.facture)).uploaded_at;

    // ── À blanc : mesurable, aucune écriture ──
    const blanc = await runCoherenceFor(sql, [moi.id], { mode: 'DRY_RUN' });
    expect(blanc.results[CHECK]).toMatchObject({ WOULD_REPAIR: 3, AMBIGUOUS: 1 });
    expect((await ligne(ids.facture)).document_date).toBe(JOUR_IMPORT);

    // ── Correctif ──
    const r1 = await runCoherenceFor(sql, [moi.id]);
    expect(r1.results[CHECK]).toMatchObject({ REPAIRED: 3, AMBIGUOUS: 1 });
    expect(await ligne(ids.facture)).toMatchObject({ document_date: '2025-12-20', uploaded_at: ajout });
    expect((await ligne(ids.sansPreuve)).document_date).toBeNull();
    expect((await ligne(ids.t1SansDate)).document_date).toBeNull();
    for (const [k, d] of [['j2019', '2019-10-22'], ['j2020', '2020-06-03'], ['j2021', '2021-01-15'], ['duJour', JOUR_IMPORT], ['manuel', JOUR_IMPORT], ['conteste', JOUR_IMPORT]] as const) {
      expect((await ligne(ids[k])).document_date, k).toBe(d);
    }
    expect((await ligne(ids.sansPreuve)).uploaded_at).toBe(ajout);
    expect((await proofOf(sql, moi.id, CHECK, ids.conteste))?.last_result).toBe('AMBIGUOUS');

    // Journal : service, avant / après, retour arrière.
    const journal = await sql<{ object_id: number; service: string; rollback_ref: string | null; ai_calls: number }[]>`
      SELECT object_id::int AS object_id, service, rollback_ref, ai_calls FROM coherence_repairs WHERE account_id = ${moi.id} AND check_id = ${CHECK} ORDER BY object_id`;
    expect(journal.map((j) => j.object_id)).toEqual([ids.facture, ids.sansPreuve, ids.t1SansDate].sort((a, b) => a - b));
    for (const j of journal) {
      expect(j.service).toBe('repairDocumentDateFallback');
      expect(j.rollback_ref).toBe(`asset_files:id=${j.object_id}:document_date=${JOUR_IMPORT}`);
      expect(j.ai_calls).toBe(0);
    }

    // ── Second passage : aucune nouvelle réparation (idempotent) ──
    const r2 = await runCoherenceFor(sql, [moi.id]);
    expect(r2.results[CHECK]?.REPAIRED ?? 0).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coherence_repairs WHERE account_id = ${moi.id} AND check_id = ${CHECK}`;
    expect(n).toBe(3);
  });

  // ══ E2E-02 ═══════════════════════════════════════════════════════════════

  it('L108D-E2E-02 — API des listes : une date documentaire par ligne, tri « Date du document » sans date en fin, date d’ajout distincte', async () => {
    const docs = await feed(moi, 'sort=docDate&direction=desc');
    const par = new Map(docs.map((d) => [d.id, d]));
    expect(par.get(ids.facture)?.documentDate).toBe('2025-12-20');
    expect([ids.j2019, ids.j2020, ids.j2021].map((i) => par.get(i)?.documentDate)).toEqual(['2019-10-22', '2020-06-03', '2021-01-15']);
    expect(par.get(ids.sansPreuve)?.documentDate).toBeNull();
    // La date d'ajout reste servie (détail, tri, filtre) — elle n'a pas remplacé la date du document.
    expect(par.get(ids.sansPreuve)?.uploadedAt).toBeTruthy();
    const sansDate = new Set([ids.sansPreuve, ids.t1SansDate]);
    for (const direction of ['desc', 'asc']) {
      const ordre = (await feed(moi, `sort=docDate&direction=${direction}`)).map((d) => d.id);
      const premiers = ordre.findIndex((i) => sansDate.has(i));
      expect(ordre.slice(premiers).every((i) => sansDate.has(i)), direction).toBe(true);
    }
    // « Date d'ajout » : filtrable et triable explicitement, tous les documents du jour d'import.
    const ajoutes = (await feed(moi, `sort=added&direction=desc&addedFrom=${JOUR_IMPORT}&addedTo=${JOUR_IMPORT}`)).map((d) => d.id);
    expect(new Set(ajoutes)).toEqual(new Set(Object.values(ids)));
    // « Date du document » sur le même champ que la colonne : le jour d'import ne ramène plus que les documents qui le prouvent.
    const duJour = (await feed(moi, `sort=added&direction=desc&docFrom=${JOUR_IMPORT}&docTo=${JOUR_IMPORT}`)).map((d) => d.id);
    expect(new Set(duJour)).toEqual(new Set([ids.duJour, ids.manuel, ids.conteste]));
  });

  // ══ E2E-03 ═══════════════════════════════════════════════════════════════

  it('L108D-E2E-03 — dépôt : jour pré-rempli d’un ancien client ignoré ; date saisie protégée contre T1 et la cohérence ; T1 sans date → vide', async () => {
    const c = await make.account({ plan: 'premium' });
    as(c);
    const today = new Date().toISOString().slice(0, 10);
    const pending = async () => (await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, s3_key, s3_bucket, original_filename, filename, mime_type, size, sha256_hash, upload_status)
      VALUES (${c.ownerUserId}, ${c.id}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'e2e-bucket', 'scan.pdf', 'scan.pdf',
              'application/pdf', 1234, ${'c'.repeat(64)}, 'PENDING') RETURNING id`)[0].id;
    const confirmer = async (body: Record<string, unknown>) => {
      const { POST } = await import('@/app/api/files/confirm/route');
      const res = await POST(new NextRequest('http://x/api/files/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      expect(res.status).toBe(200);
    };

    // Ancien client : date du jour pré-remplie, sans marque → ignorée.
    const ancien = await pending();
    await confirmer({ fileId: ancien, documentDate: today });
    expect(await ligne(ancien)).toMatchObject({ document_date: null });
    // Ancien client, autre date choisie : conservée, sans marque utilisateur.
    const ancienChoix = await pending();
    await confirmer({ fileId: ancienChoix, documentDate: '2021-01-15' });
    expect(await ligne(ancienChoix)).toMatchObject({ document_date: '2021-01-15' });
    expect((await ligne(ancienChoix)).ue?.documentDate).toBeUndefined();
    // Nouveau client : date saisie (même le jour même) → posée et marquée.
    const saisie = await pending();
    await confirmer({ fileId: saisie, documentDate: today, documentDateSource: 'USER' });
    expect(await ligne(saisie)).toMatchObject({ document_date: today, ue: { documentDate: true } });

    // T1 lit une AUTRE date certaine : la saisie reste.
    const analyser = async (id: number, date: string | null) => {
      await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${id}`;
      const sortie = sortieT1({ title: 'Facture entretien', date: date ?? '2000-01-01', documentTypeCode: 'INVOICE', rubricCode: 'MAINTENANCE_WORKS', assets: [], facts: [] });
      if (!date) delete (sortie.document as Record<string, unknown>).documentDate;
      await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie, repeat: true }]);
      const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
      const r = await analyzeFileSources([id], c.id, { userId: c.ownerUserId, billable: false, origin: 'e2e/l108d' });
      if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${id} en échec`);
      await drainQueues();
    };
    await analyser(saisie, '2022-03-14');
    expect((await ligne(saisie)).document_date).toBe(today);
    // Le contrôle de cohérence ne la touche pas non plus (marque utilisateur), alors qu'elle égale le jour d'import.
    await runCoherenceFor(sql, [c.id]);
    expect((await ligne(saisie)).document_date).toBe(today);
    const p = await proofOf(sql, c.id, CHECK, saisie);
    expect(p === null || p.last_result === 'CONSISTENT').toBe(true);

    // T1 sans date lisible sur un dépôt sans date : la date reste vide (aucun repli).
    await analyser(ancien, null);
    expect((await ligne(ancien)).document_date).toBeNull();
    const docs = await feed(c, 'sort=added&direction=desc');
    expect(docs.find((d) => d.id === ancien)?.documentDate).toBeNull();
  });
});
