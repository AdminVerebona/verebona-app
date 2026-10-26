/**
 * Lot 88A — diagnostic global exhaustif et auto-suffisant d'un compte
 * (ticket P1), sur PostgreSQL 16 réel, PAR LA VRAIE ROUTE
 * (`GET /api/admin/diagnostics?scope=account` — lot 91A : filtre compte du moteur unique, garde `requireAdmin` réelle :
 * seule la lecture du cookie de session est simulée).
 *
 * Test de référence « prix d'achat », traité comme un cas GÉNÉRAL : un bien
 * avec une date d'achat mais SANS prix, trois documents (acte, compromis,
 * offre de prêt), des faits T1, des preuves, deux valeurs candidates en
 * conflit, une décision T3 « create_conflict », un rapport T3 « non écrit »,
 * une écriture réussie sur la date. À partir du SEUL ZIP, chaque maillon est
 * retrouvé. Un compte B ne fuit pas.
 *
 * Lecture seule : ce scénario n'écrit que ses propres données de test et
 * n'assert que sur ses comptes (base partagée du harnais, aucune suppression).
 *
 *   · L88A-E01 couverture : chaque table RÉELLEMENT présente en base (toutes
 *     migrations) est déclarée au registre du diagnostic ;
 *   · L88A-E02 manifeste : sections COMPLETE / NOT_APPLICABLE, attendus =
 *     exportés pour chaque fichier, SHA-256, guide d'analyse, statut global ;
 *   · L88A-E03 chaîne du prix d'achat depuis le ZIP seul : documents, montants
 *     détectés, faits T1, preuves (document, page, extrait), rattachement au
 *     bien, candidats concurrents, conflit et décision T3, écriture non
 *     réalisée et motif, valeur persistée, valeur API, champ affiché ;
 *     corrélation décision → écriture sur la date d'achat ;
 *   · L88A-E04 auto-contrôle : une référence pendante (décision citant une
 *     preuve inexistante) et un compteur annoncé non détaillé
 *     (factsPersisted = 9 pour 2 lignes) sont DÉCLARÉS — sections PARTIAL,
 *     statut global PARTIAL, valeurs listées ;
 *   · L88A-E05 isolation : aucune ligne ni valeur du compte B ;
 *   · L88A-E06 sécurité : mot de passe (hash), jeton de partage, contenu de
 *     prompt, e-mail en clair absents ; exclusions déclarées au manifeste ;
 *   · L88A-E07 consultation (JSON) : sections et auto-contrôle renvoyés ;
 *     compte inconnu → 404 ; utilisateur non administrateur → 403.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

scenario('L88A', 'Diagnostic global d’un compte : exhaustif, auto-suffisant, fermé, isolé', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); });

  async function seConnecter(role: 'ADMIN' | 'USER') {
    const u = await make.user({ role });
    session.userId = u.id; session.role = role; session.email = u.email;
  }
  let GET: (r: import('next/server').NextRequest) => Promise<Response>;
  let NextRequest: typeof import('next/server').NextRequest;
  const appel = (qs: string) => GET(new NextRequest(`http://app.test/api/admin/diagnostics?${qs}`));
  async function zip(qs: string): Promise<{ files: Record<string, string>; raw: string }> {
    const res = await appel(`${qs}&format=zip`);
    expect(res.status, await res.clone().text().catch(() => '')).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const files: Record<string, string> = {};
    for (const [name, f] of Object.entries(z.files)) if (!f.dir) files[name] = await f.async('string');
    for (const [name, c] of Object.entries(files)) if (name.endsWith('.json')) expect(() => JSON.parse(c), name).not.toThrow();
    return { files, raw: Object.values(files).join('\n') };
  }
  const parse = <T = Json>(files: Record<string, string>, p: string): T => {
    expect(files[p], `fichier ${p} absent du ZIP`).toBeDefined();
    return JSON.parse(files[p]) as T;
  };
  /** Lignes d'une table du compte (toutes parties). */
  const rows = (files: Record<string, string>, section: string, table: string): Json[] => {
    const base = `donnees/${section}/${table}`;
    return Object.keys(files).filter((p) => p === `${base}.json` || p.startsWith(`${base}.part-`)).sort().flatMap((p) => JSON.parse(files[p]) as Json[]);
  };

  const ids: Record<string, number> = {};
  let A: AccountRow & { owner: { id: number; email: string } };
  let B: AccountRow & { owner: { id: number; email: string } };
  const PROMPT_SECRET = 'Analyse cet acte — clé sk-l88aFAKEFAKEFAKEFAKEFAKE1234';

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    GET = (await import('@/app/api/admin/diagnostics/route')).GET as never;

    A = await make.account({ plan: 'premium', name: 'Compte Prix Achat L88A' });
    B = await make.account({ plan: 'premium', name: 'Compte Etranger L88A' });
    await sql`UPDATE users SET password_hash = 'HASH-SECRET-L88A-$2b$10$abcdefghijklmnop' WHERE id = ${A.owner.id}`;
    await sql`UPDATE accounts SET calendar_share_token = 'JETON-PARTAGE-L88A-123456' WHERE id = ${A.id}`;
    const maison = await make.asset(A, {
      category: 'IMMOBILIER', name: 'Maison des Tilleuls',
      keyCharacteristics: { acquisitionDate: '2020-06-15', acquisitionDate__origin: 'DOCUMENT_EXTRACTION', acquisitionDate__evidenceId: 0 },
    });
    ids.asset = maison.id;

    // Trois documents : acte, compromis, offre de prêt (financement).
    const doc = async (title: string, date: string) => {
      const f = await make.assetFile(A, { assetId: maison.id });
      await sql`UPDATE asset_files SET retained_title = ${title}, document_date = ${date}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
      const ex = (await sql<{ id: number }[]>`
        INSERT INTO document_extractions (account_id, file_id, provider, model, prompt_version, operation_trace_id, fact_count, document_date)
        VALUES (${A.id}, ${f.id}, 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v7', ${`tr-l88a-${f.id}`}, 2, ${date}) RETURNING id`)[0].id;
      return { file: f.id, extraction: Number(ex) };
    };
    const acte = await doc('Acte de vente', '2020-06-15');
    const compromis = await doc('Compromis de vente', '2020-03-02');
    const pret = await doc('Offre de prêt immobilier', '2020-04-10');
    Object.assign(ids, { acte: acte.file, compromis: compromis.file, pret: pret.file, exActe: acte.extraction, exCompromis: compromis.extraction, exPret: pret.extraction });
    const fact = async (d: { file: number; extraction: number }, key: string, value: number | null, text: string | null, excerpt: string, page: number) => Number((await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_text, value_unit, confidence, excerpt, location, status, provider, model, prompt_version, source_unit_ids)
      VALUES (${A.id}, ${d.file}, ${d.extraction}, ${key}, ${key}, ${key}, ${value}, ${text}, ${value === null ? null : 'EUR'}, 'certain', ${excerpt}, ${JSON.stringify({ page })}::jsonb, 'active',
              'gemini', 'gemini-2.5-pro', 't1_analyze_document@v7', ${[`p${page}-u1`]})
      RETURNING id`)[0].id);
    ids.factPrixActe = await fact(acte, 'acquisitionPrice', 350000, null, 'Prix de vente : 350 000,00 €', 3);
    ids.factDateActe = await fact(acte, 'acquisitionDate', null, '2020-06-15', 'Fait à Lyon le 15 juin 2020', 7);
    ids.factPrixCompromis = await fact(compromis, 'acquisitionPrice', 345000, null, 'Prix convenu : 345 000 €', 2);
    ids.factPret = await fact(pret, 'loanAmount', 280000, null, 'Montant du prêt : 280 000 €', 1);
    // Unités sources (entrée utile de T1) citées par les faits.
    for (const [d, unit, page, text] of [[acte, 'p3-u1', 3, 'Prix de vente : 350 000,00 €'], [acte, 'p7-u1', 7, 'Fait à Lyon le 15 juin 2020'],
      [compromis, 'p2-u1', 2, 'Prix convenu : 345 000 €'], [pret, 'p1-u1', 1, 'Montant du prêt : 280 000 €']] as const) {
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, content_text, coverage_status)
                VALUES (${A.id}, ${d.file}, ${d.extraction}, ${unit}, 'TEXT_BLOCK', ${page}, 1, ${text}, 'COVERED')`;
    }

    // Preuves projetées sur le bien (valeurs candidates de T3).
    const ev = async (fileId: number, key: string, value: unknown, excerpt: string, page: number) => Number((await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, normalized_value, source_type, source_id, source_location, evidence_excerpt,
                                  confidence, authority_score, status, lifecycle_status, fingerprint, provider, model, prompt_version, target_type, target_entity_id)
      VALUES (${A.id}, ${maison.id}, ${key}, ${key}, ${JSON.stringify(value)}::jsonb, ${String(value)}, 'document', ${fileId}, ${JSON.stringify({ page })}::jsonb, ${excerpt},
              'certain', 80, 'active', 'ACTIVE', ${`l88a-${fileId}-${key}-${Math.random()}`}, 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v7', 'ASSET', ${maison.id})
      RETURNING id`)[0].id);
    ids.evPrixActe = await ev(acte.file, 'acquisitionPrice', 350000, 'Prix de vente : 350 000,00 €', 3);
    ids.evPrixCompromis = await ev(compromis.file, 'acquisitionPrice', 345000, 'Prix convenu : 345 000 €', 2);
    ids.evDate = await ev(acte.file, 'acquisitionDate', '2020-06-15', 'Fait à Lyon le 15 juin 2020', 7);

    // Passage T3 : date appliquée, prix en conflit (deux candidats) ; écriture de la date.
    const run = (await sql<{ id: number; trace: string }[]>`
      INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, shadow, trace_id, status, decisions_count, applied_count, conflict_count)
      VALUES (${A.id}, ${maison.id}, 'document_analyzed', false, gen_random_uuid(), 'completed', 2, 1, 1) RETURNING id, trace_id::text AS trace`)[0];
    ids.run = Number(run.id);
    ids.decDate = Number((await sql<{ id: number }[]>`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
      VALUES (${ids.run}, ${A.id}, ${maison.id}, 'acquisitionDate', 'apply', 'SINGLE_SOURCE', 'certain', true, ${JSON.stringify([ids.evDate])}::jsonb) RETURNING id`)[0].id);
    ids.decPrix = Number((await sql<{ id: number }[]>`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
      VALUES (${ids.run}, ${A.id}, ${maison.id}, 'acquisitionPrice', 'create_conflict', 'CONFLICTING_SOURCES', 'conflictual', true, ${JSON.stringify([ids.evPrixActe, ids.evPrixCompromis])}::jsonb) RETURNING id`)[0].id);
    ids.conflit = Number((await sql<{ id: number }[]>`INSERT INTO inconsistency_registry (account_id, asset_id, field_key, current_value, proposed_value, source_type, inconsistency_type, status,
        current_evidence_ids, proposed_evidence_ids, reason_code)
      VALUES (${A.id}, ${maison.id}, 'acquisitionPrice', '345000', '350000', 'document', 'VALUE_CONFLICT', 'open',
              ${JSON.stringify([ids.evPrixCompromis])}::jsonb, ${JSON.stringify([ids.evPrixActe])}::jsonb, 'CONFLICTING_SOURCES') RETURNING id`)[0].id);
    ids.ecritureDate = Number((await sql<{ id: number }[]>`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, trace_id, outcome, dry_run)
      VALUES (${A.id}, ${maison.id}, 'acquisitionDate', 'null'::jsonb, '"2020-06-15"'::jsonb, 'RECONCILIATION', 'document', ${String(acte.file)}, ${run.trace}, 'written', false) RETURNING id`)[0].id);

    // Traitements : job T1, appel IA (et sa capture), rapport T1 (2 faits persistés), rapport T3 (prix non écrit).
    ids.job = Number((await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, trigger_code, attempts, last_error, finished_at)
      VALUES ('T1', ${A.id}, 'asset_file', ${String(acte.file)}, ${`l88a-t1-${acte.file}`}, 'DONE', 'source_uploaded', 2, 'tentative 1 : délai dépassé', now()) RETURNING id`)[0].id);
    ids.usage = Number((await sql<{ id: number }[]>`INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, provider, model, status, input_tokens, output_tokens, metadata, job_id, operation_code, environment, master_prompt_code, master_prompt_version)
      VALUES (${A.id}, ${acte.file}, 'extraction', 'gemini', 'gemini-2.5-pro', 'success', 1500, 400, ${JSON.stringify({ traceId: `tr-l88a-${acte.file}` })}::jsonb, ${ids.job}, 't1_analyze_document', 'test', 'T1_MASTER', '7')
      RETURNING id`)[0].id);
    await sql`INSERT INTO ai_call_captures (trace_id, usage_event_id, call_index, call_kind, origin, account_id, operation_code, model, capture_status, prompt_status, response_status, prompt_text, prompt_chars, response_raw, response_chars)
              VALUES (${`tr-l88a-${acte.file}`}, ${ids.usage}, 0, 'PRIMARY', 'T1', ${A.id}, 't1_analyze_document', 'gemini-2.5-pro', 'CAPTURED', 'CAPTURED', 'CAPTURED', ${PROMPT_SECRET}, ${PROMPT_SECRET.length}, '{"acquisitionPrice": 350000}', 28)`;
    ids.rapportT1 = Number((await sql<{ id: number }[]>`INSERT INTO ai_execution_reports (account_id, treatment, scope, job_id, trace_ids, file_id, asset_id, extraction_id, status, entry_count, counters)
      VALUES (${A.id}, 'T1', 'DOCUMENT', ${ids.job}, ${[`tr-l88a-${acte.file}`]}, ${acte.file}, ${maison.id}, ${acte.extraction}, 'SUCCESS', 2, ${JSON.stringify({ factsPersisted: 2 })}::jsonb) RETURNING id`)[0].id);
    await sql`INSERT INTO ai_execution_report_entries (report_id, seq, account_id, section, table_name, record_id, field_key, value, write_result) VALUES
              (${ids.rapportT1}, 1, ${A.id}, 'FACT', 'document_facts', ${String(ids.factPrixActe)}, 'acquisitionPrice', '350000'::jsonb, 'WRITTEN'),
              (${ids.rapportT1}, 2, ${A.id}, 'FACT', 'document_facts', ${String(ids.factDateActe)}, 'acquisitionDate', '"2020-06-15"'::jsonb, 'WRITTEN')`;
    ids.rapportT3 = Number((await sql<{ id: number }[]>`INSERT INTO ai_execution_reports (account_id, treatment, scope, asset_id, reconciliation_run_id, status, entry_count, counters)
      VALUES (${A.id}, 'T3', 'ASSET', ${maison.id}, ${ids.run}, 'SUCCESS', 2, ${JSON.stringify({ conflicts: 1, written: 1 })}::jsonb) RETURNING id`)[0].id);
    await sql`INSERT INTO ai_execution_report_entries (report_id, seq, account_id, section, table_name, record_id, field_key, entity_type, entity_id, value, write_result, reason_code, reason) VALUES
              (${ids.rapportT3}, 1, ${A.id}, 'FIELD', 'canonical_field_writes', ${String(ids.ecritureDate)}, 'acquisitionDate', 'ASSET', ${maison.id}, '"2020-06-15"'::jsonb, 'WRITTEN', NULL, NULL),
              (${ids.rapportT3}, 2, ${A.id}, 'FIELD', NULL, NULL, 'acquisitionPrice', 'ASSET', ${maison.id}, '350000'::jsonb, 'NOT_WRITTEN', 'CONFLICT_CREATED', 'Valeurs concurrentes : conflit créé, aucune écriture')`;

    // Compte B (isolation) : mêmes types de données, valeurs reconnaissables.
    const autre = await make.asset(B, { category: 'IMMOBILIER', name: 'Bien Secret Etranger L88A', keyCharacteristics: { acquisitionPrice: 7771919 } });
    ids.assetB = autre.id;
    const fB = await make.assetFile(B, { assetId: autre.id });
    ids.fileB = fB.id;
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, source_location, evidence_excerpt, confidence, authority_score, status, fingerprint)
              VALUES (${B.id}, ${autre.id}, 'acquisitionPrice', '7771919'::jsonb, 'document', ${fB.id}, '{}'::jsonb, 'EXTRAIT-ETRANGER-L88A', 'certain', 80, 'active', ${`l88a-b-${fB.id}`})`;
    for (const k of Object.keys(ids)) ids[k] = Number(ids[k]);
  });

  it('L88A-E01 couverture : chaque table réellement présente en base est déclarée au registre du diagnostic', async () => {
    const { classifyDiagTables } = await import('@/services/admin/diagnostics-export/coverage');
    const tables = (await sql<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map((r) => r.t);
    const c = classifyDiagTables(tables);
    expect(c.unclassified, 'tables à déclarer dans coverage.ts').toEqual([]);
    expect(c.missing, 'tables déclarées absentes de la base').toEqual([]);
    expect(c.covered.length + c.excluded.length).toBe(tables.length);
  });

  let Z: { files: Record<string, string>; raw: string };
  it('L88A-E02 ZIP du compte : manifeste par section, attendus = exportés, guide d’analyse', async () => {
    await seConnecter('ADMIN');
    Z = await zip(`scope=account&id=${A.id}&period=all`);
    const m = parse(Z.files, 'manifeste.json');
    expect(m.request.scope).toBe('account');
    expect(m.target.accountIds).toEqual([A.id]);
    expect(m.status, JSON.stringify(m.sections?.filter((x: Json) => x.status !== 'COMPLETE' && x.status !== 'NOT_APPLICABLE'), null, 1)).toBe('COMPLETE');
    expect(m.autoControle.references.absentes).toBe(0);
    expect(m.autoControle.compteursAnnonces.ecartsStricts).toBe(0);
    const codes = (m.sections as Json[]).map((x) => x.code);
    for (const c of ['etat-metier', 'documents', 'relations', 'extractions-ia', 'preuves', 'candidats', 'conflits-arbitrages', 'ecritures', 'corrections-utilisateur',
      'rapprochements-agenda-controles', 'historique', 'technique', 'referentiels', 'api-ui', 'tracabilite', 'controle']) expect(codes, c).toContain(c);
    for (const s of m.sections as Json[]) {
      expect(['COMPLETE', 'NOT_APPLICABLE'], `${s.code} : ${s.motif}`).toContain(s.status);
      for (const f of s.files) {
        if (f.expected !== null && f.expected !== undefined) expect(f.count, f.path).toBe(f.expected);
        expect(f.sha256, f.path).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    // Chaque fichier de données est décrit et vérifiable (SHA-256 du contenu).
    const { createHash } = await import('node:crypto');
    for (const f of m.files as Json[]) {
      if (!Z.files[f.path] || f.path === 'manifeste.json') continue;
      expect(createHash('sha256').update(Z.files[f.path]).digest('hex'), f.path).toBe(f.sha256);
    }
    expect(Z.files['LISEZMOI-ANALYSE.md']).toMatch(/document → extraction → unité source → fait → preuve/);
    expect(m.couverture.nonClassees).toEqual([]);
    // Migrations appliquées : liste complète et décompte concordants.
    expect(rows(Z.files, 'technique', '_migrations').length).toBeGreaterThan(100);
    expect(parse(Z.files, 'technique/versions.json').migrations.appliquees).toBe(rows(Z.files, 'technique', '_migrations').length);
  });

  it('L88A-E03 prix d’achat : chaque maillon retrouvé à partir du seul ZIP', async () => {
    const F = Z.files;
    // Documents concernant l'achat, et leur rattachement au bien.
    const docs = rows(F, 'documents', 'asset_files').filter((d) => d.asset_id === ids.asset);
    expect(docs.map((d) => d.id).sort()).toEqual([ids.acte, ids.compromis, ids.pret].sort());
    expect(docs.find((d) => d.id === ids.acte)?.retained_title).toBe('Acte de vente');
    // Montants détectés par T1 (tous les faits, pas un compteur) et extraction (modèle, version de prompt).
    const faits = rows(F, 'extractions-ia', 'document_facts').filter((f) => [ids.acte, ids.compromis, ids.pret].includes(f.file_id));
    expect(faits.map((f) => [f.canonical_key, Number(f.value_number ?? 0)]).sort()).toEqual([['acquisitionDate', 0], ['acquisitionPrice', 345000], ['acquisitionPrice', 350000], ['loanAmount', 280000]]);
    expect(rows(F, 'extractions-ia', 'document_extractions').find((x) => x.id === ids.exActe)).toMatchObject({ model: 'gemini-2.5-pro', prompt_version: 't1_analyze_document@v7' });
    expect(rows(F, 'extractions-ia', 'document_source_units').find((u) => u.source_unit_id === 'p3-u1')?.content_text).toBe('Prix de vente : 350 000,00 €');
    // Rapport T1 : factsPersisted = 2 → les 2 faits détaillés.
    expect(rows(F, 'ecritures', 'ai_execution_report_entries').filter((e) => Number(e.report_id) === ids.rapportT1 && e.section === 'FACT')).toHaveLength(2);

    // Chaîne de la propriété.
    const props = parse<Json[]>(F, 'tracabilite/proprietes.json');
    const prix = props.find((p) => p.bien === ids.asset && p.champ === 'acquisitionPrice' && p.cible === `ASSET#${ids.asset}`)!;
    expect(prix).toBeDefined();
    expect(prix.verdict).toBe('VIDE_EN_BASE');
    expect(prix.persiste.fiche.valeur).toBeNull();
    expect(prix.persiste.colonne).toMatchObject({ colonne: 'purchase_price_cents (÷ 100)', valeur: null });
    expect(prix.api).toMatchObject({ route: 'GET /api/assets/[id]/details', http: 200, section: 'common', renvoye: true, valeur: null });
    expect(prix.affichage.champs[0]).toMatchObject({ section: 'common', libelle: 'Prix d\'achat (€)', recuDeLApi: true, valeurLue: null });
    expect(prix.affichage.composant).toMatch(/AssetDetailsTab/);
    // Preuves (candidats) : document, page, extrait, confiance ; rattachées au bien.
    expect(prix.preuves.map((e: Json) => [e.id, e.document, e.page]).sort()).toEqual([[ids.evPrixActe, ids.acte, 3], [ids.evPrixCompromis, ids.compromis, 2]].sort());
    expect(prix.preuves.find((e: Json) => e.id === ids.evPrixActe)).toMatchObject({ evidence_excerpt: 'Prix de vente : 350 000,00 €', confidence: 'certain', target_type: 'ASSET' });
    // Faits du même champ, avec leur projection en preuve.
    expect(prix.faits.map((f: Json) => [f.id, Number(f.value_number), f.projeteEnPreuve]).sort()).toEqual([[ids.factPrixActe, 350000, true], [ids.factPrixCompromis, 345000, true]].sort());
    expect(prix.extractions.map((x: Json) => x.id).sort()).toEqual([ids.exActe, ids.exCompromis].sort());
    expect(prix.documents.map((d: Json) => d.id).sort()).toEqual([ids.acte, ids.compromis].sort());
    // Conflit et décision T3 : candidats concurrents, preuves de chaque côté, action et motif.
    expect(prix.decisions).toHaveLength(1);
    expect(prix.decisions[0]).toMatchObject({ id: ids.decPrix, action: 'create_conflict', reason_code: 'CONFLICTING_SOURCES', evidence_ids: [ids.evPrixActe, ids.evPrixCompromis], triggered_by: 'document_analyzed' });
    expect(prix.decisions[0].resultatRapport).toEqual([{ rapport: ids.rapportT3, seq: 2, ecriture: 'NOT_WRITTEN', motif: 'CONFLICT_CREATED', detail: 'Valeurs concurrentes : conflit créé, aucune écriture' }]);
    expect(prix.conflits).toHaveLength(1);
    expect(prix.conflits[0]).toMatchObject({ id: ids.conflit, current_value: '345000', proposed_value: '350000', current_evidence_ids: [ids.evPrixCompromis], proposed_evidence_ids: [ids.evPrixActe], status: 'open' });
    // Écriture : aucune sur le prix (erreur de décision ≠ erreur de persistance) ; traitements.
    expect(prix.ecritures).toEqual([]);
    expect(prix.ecrituresRapport.map((e: Json) => e.write_result)).toEqual(['NOT_WRITTEN']);
    expect(prix.traitements.rapports.map((r: Json) => r.id)).toEqual(expect.arrayContaining([ids.rapportT1, ids.rapportT3]));
    expect(prix.traitements.jobs).toContain(ids.job);
    // Traitement : job (tentatives, erreur), appel IA (modèle, prompt maître), sans contenu de prompt.
    expect(rows(F, 'technique', 'ai_job_queue').find((j) => j.id === ids.job)).toMatchObject({ attempts: 2, last_error: 'tentative 1 : délai dépassé', status: 'DONE' });
    expect(rows(F, 'technique', 'ai_usage_event').find((u) => u.id === ids.usage)).toMatchObject({ master_prompt_code: 'T1_MASTER', master_prompt_version: '7', input_tokens: 1500, job_id: ids.job });

    // Date d'achat : décision appliquée, écriture corrélée (même trace), valeur persistée, renvoyée et affichée.
    const date = props.find((p) => p.bien === ids.asset && p.champ === 'acquisitionDate' && p.cible === `ASSET#${ids.asset}`)!;
    expect(date.verdict).toBe('COHERENT');
    expect(date.persiste.fiche).toMatchObject({ valeur: '2020-06-15', meta: { origin: 'DOCUMENT_EXTRACTION' } });
    expect(date.api.valeur).toBe('2020-06-15');
    expect(date.decisions[0]).toMatchObject({ id: ids.decDate, action: 'apply', ecrituresCorrelees: [ids.ecritureDate] });
    expect(date.ecritures[0]).toMatchObject({ id: ids.ecritureDate, outcome: 'written', new_value: '2020-06-15' });

    // Fermeture : chaque référence de la chaîne est résolue (décision → preuves → documents → extraction).
    const refs = parse(F, 'controle/references.json');
    const ref = (from: string, column: string) => (refs.references as Json[]).find((r) => r.from === from && r.column === column);
    expect(ref('reconciliation_decisions', 'evidence_ids')).toMatchObject({ valeurs: 3, resolues: 3, absentes: [] });
    expect(ref('field_evidence', 'source_id')).toMatchObject({ resolues: 2, absentes: [] });
    expect(ref('document_facts', 'extraction_id')).toMatchObject({ resolues: 3, absentes: [] });
    // API → écran : fiche recalculée, et champ attendu par l'écran dans une autre section signalé.
    const fiche = parse<Json[]>(F, 'api-ui/fiches.json').find((x) => x.bien === ids.asset)!;
    expect(fiche.reponseApi.sections.common).toMatchObject({ acquisitionDate: '2020-06-15', acquisitionPrice: null });
    expect(parse(F, 'api-ui/correspondance-champs.json').champsCommuns.IMMOBILIER.map((x: Json) => x.key)).toContain('acquisitionPrice');
  });

  it('L88A-E04 auto-contrôle : référence pendante et compteur annoncé non détaillé DÉCLARÉS (jamais COMPLETE)', async () => {
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
              VALUES (${ids.run}, ${A.id}, ${ids.asset}, 'acquisitionPrice', 'ignore', 'L88A_PENDANTE', 'probable', true, '[987654321]'::jsonb)`;
    const r9 = Number((await sql<{ id: number }[]>`INSERT INTO ai_execution_reports (account_id, treatment, scope, file_id, asset_id, status, entry_count, counters)
      VALUES (${A.id}, 'T1', 'DOCUMENT', ${ids.compromis}, ${ids.asset}, 'SUCCESS', 2, ${JSON.stringify({ factsPersisted: 9 })}::jsonb) RETURNING id`)[0].id);
    await sql`INSERT INTO ai_execution_report_entries (report_id, seq, account_id, section, table_name, record_id, field_key, value, write_result) VALUES
              (${r9}, 1, ${A.id}, 'FACT', 'document_facts', ${String(ids.factPrixCompromis)}, 'acquisitionPrice', '345000'::jsonb, 'WRITTEN'),
              (${r9}, 2, ${A.id}, 'FACT', 'document_facts', '0', 'x', '1'::jsonb, 'WRITTEN')`;
    const z = await zip(`scope=account&id=${A.id}&period=all`);
    const m = parse(z.files, 'manifeste.json');
    expect(m.status).toBe('PARTIAL');
    const sec = (c: string) => (m.sections as Json[]).find((x) => x.code === c)!;
    expect(sec('conflits-arbitrages').status).toBe('PARTIAL');
    expect(sec('conflits-arbitrages').errors.join(' ')).toMatch(/reconciliation_decisions\.evidence_ids → field_evidence\.id absente/);
    expect(sec('extractions-ia').status).toBe('PARTIAL');
    expect(sec('extractions-ia').errors.join(' ')).toMatch(/factsPersisted/);
    expect(m.autoControle.references.absentes).toBe(1);
    expect(m.autoControle.compteursAnnonces.ecartsStricts).toBe(1);
    const refs = parse(z.files, 'controle/references.json');
    expect((refs.references as Json[]).find((r) => r.from === 'reconciliation_decisions' && r.column === 'evidence_ids')?.absentes).toEqual(['987654321']);
    const ctl = parse<Json[]>(z.files, 'controle/compteurs-annonces.json').find((c) => c.code === 'T1_FACTS_PERSISTED')!;
    expect(ctl.ecarts).toEqual([{ id: r9, annonce: 9, present: 2 }]);
    // Remise en état des données du scénario (les autres assertions portent sur le premier ZIP).
    await sql`DELETE FROM reconciliation_decisions WHERE account_id = ${A.id} AND reason_code = 'L88A_PENDANTE'`;
    await sql`DELETE FROM ai_execution_report_entries WHERE report_id = ${r9}`;
    await sql`DELETE FROM ai_execution_reports WHERE id = ${r9}`;
  });

  it('L88A-E05 isolation stricte : aucune ligne ni valeur du compte B', () => {
    expect(Z.raw).not.toMatch(/Bien Secret Etranger L88A|EXTRAIT-ETRANGER-L88A|7771919/);
    expect(Z.raw).not.toContain('Compte Etranger L88A');
    for (const [p, c] of Object.entries(Z.files)) {
      if (!p.startsWith('donnees/') || !p.endsWith('.json')) continue;
      for (const r of JSON.parse(c) as Json[]) {
        if (r && typeof r === 'object' && 'account_id' in r && r.account_id !== null) expect(r.account_id, `${p} #${r.id}`).toBe(A.id);
      }
    }
    expect(rows(Z.files, 'etat-metier', 'assets').map((a) => a.id)).toEqual([ids.asset]);
    expect(rows(Z.files, 'etat-metier', 'accounts').map((a) => a.id)).toEqual([A.id]);
  });

  it('L88A-E06 sécurité : aucun secret, contenu restreint, exclusions déclarées', () => {
    expect(Z.raw).not.toContain('HASH-SECRET-L88A');
    expect(Z.raw).not.toContain('JETON-PARTAGE-L88A');
    expect(Z.raw).not.toContain('sk-l88aFAKE');
    expect(Z.raw).not.toContain(A.owner.email);
    const user = rows(Z.files, 'etat-metier', 'users').find((u) => u.id === A.owner.id)!;
    expect(user).toBeDefined();
    expect('password_hash' in user).toBe(false);
    expect(user.email).toMatchObject({ $etat: 'masque', motif: 'e-mail' });
    expect('calendar_share_token' in rows(Z.files, 'etat-metier', 'accounts')[0]).toBe(false);
    const cap = rows(Z.files, 'technique', 'ai_call_captures').find((c) => Number(c.usage_event_id) === ids.usage)!;
    expect(cap.prompt_text).toMatchObject({ $etat: 'masque', longueur: PROMPT_SECRET.length });
    const m = parse(Z.files, 'manifeste.json');
    expect(m.exclusionsVolontaires.colonnes).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'users', colonne: 'password_hash' }), expect.objectContaining({ table: 'accounts', colonne: 'calendar_share_token' })]));
    expect(m.exclusionsVolontaires.tables).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'revoked_tokens', categorie: 'SECURITE' })]));
    expect(m.exclusionsVolontaires.notes.join(' ')).toMatch(/MOT_DE_PASSE/);
  });

  it('L88A-E07 consultation JSON, compte inconnu, accès réservé', async () => {
    await seConnecter('ADMIN');
    const res = await appel(`scope=account&id=${A.id}&period=all`);
    expect(res.status).toBe(200);
    const v = await res.json() as Json;
    expect(v.manifest.sections.find((x: Json) => x.code === 'preuves')).toMatchObject({ status: 'COMPLETE' });
    expect(v.manifest.autoControle.conclusion).toMatch(/Aucun manque constaté/);
    expect(v.files.map((f: Json) => f.path)).toContain('tracabilite/proprietes.json');
    expect((await appel('scope=account&id=999999999&period=all')).status).toBe(404);
    await seConnecter('USER');
    expect((await appel(`scope=account&id=${A.id}&period=all&format=zip`)).status).toBe(403);
  });
});
