/**
 * Carte Trello #839 — pipeline fournisseur et nommage des périodes, titres et reprises, sur PostgreSQL
 * RÉEL avec IA SIMULÉE (rejeu derrière la passerelle réelle : aucun appel réseau, aucun prompt actif
 * du dépôt modifié — la version « active » du prompt T1 est posée pour le test seulement).
 *
 * Trajet exercé (E1) : sortie maître JSON portant `document.supplier.identity` → passerelle (contrat
 * runtime, schéma fournisseur projeté, lecture tolérante + Zod) → projection `toSourceAnalysisResult`
 * (contrôle de la preuve) → `document_analysis_runs.raw_response_json` → `loadPersistedTitleInputs`
 * → `ensureBusinessTitle` → titre persisté + `document_title_events`.
 *
 *   C839-E2E-01  identité PROUVÉE : enseigne dans le titre, sans établissement ni garantie ; données
 *                fournisseur d'origine et référentiel inchangés ; garantie toujours structurée
 *   C839-E2E-02  identité ABSENTE (nom lu, aucune coupe) ; ancienne forme `evidence.quote` acceptée
 *   C839-E2E-03  identité MAL FORMÉE : retirée seule, analyse réussie, nom lu
 *   C839-E2E-04  citation NON VÉRIFIABLE et confiance FAIBLE : conservées, jamais exploitées
 *   C839-E2E-05  prompt SANS le bloc 52 et coupure T1_SUPPLIER_IDENTITY_ENABLED=0 (analyse et reprise)
 *   C839-E2E-06  rejeu : seconde analyse identique et contrôle — aucun changement, champs conservés
 *   C839-E2E-10  garantie présentée à tort en `document.billingPeriod`, et en `financialHints`
 *   C839-E2E-11  qualification ILLISIBLE : abstention (fait conservé) ; fait non typé lisible : comme avant
 *   C839-E2E-12  garantie + vraie période facturée (bornes différentes, puis identiques) ; abonnement mensuel
 *   C839-E2E-13  T3 : une proposition reprenant la garantie est refusée (données réelles du document)
 *   C839-E2E-14  titres longs : aucun modèle coupé, réduction des accessoires, limite commune
 *   C839-E2E-15  reprise COH-DOC-TITLES : simulation sans écriture, réparation ciblée et motivée,
 *                titre USER et ancien `legacy_user_edit` protégés, compte A ≠ compte B, 2e passage idempotent
 *   C839-E2E-16  journalisation en échec : le titre n'est PAS écrit sans son événement (même transaction)
 *
 * Assertions bornées aux comptes créés ici. Valeurs du cas contractuel : données de TEST uniquement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { AccountRow } from '../factories';
import type { RecordedOutput } from '../replay-gateway';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, fh, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';
import { proofOf, runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;

// ── Cas contractuel SYNTHÉTIQUE de la carte (valeurs de test) ───────────────
const NOM_LU = 'CONFORAMA FRANCE SA CHASSE S/R';
const LIGNE_EMETTEUR = 'CONFORAMA FRANCE SA - Magasin de Chasse S/R';
const OBJET = 'Table FAR CI606025BK';
const EMISSION = '2026-11-14';
const GARANTIE = { s: '2026-11-14', e: '2028-11-14' };
const LIGNE_GARANTIE = 'Garantie 2 ans du 14/11/2026 au 14/11/2028';
const IDENTITE = {
  legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: 'Chasse S/R',
  confidence: 'certain', evidence: { excerpt: LIGNE_EMETTEUR, page: 1 },
};
const TITRE_ENSEIGNE = `Facture ${OBJET} Conforama — 14 novembre 2026`;
/** Sans identité exploitable : le nom LU, tel quel (règle générale inchangée : ni coupe, ni casse retouchée). */
const TITRE_NOM_LU = `Facture ${OBJET} ${NOM_LU} — 14 novembre 2026`;

// ── Prompt T1 « actif » du test : texte livré + bloc 52 RÉVISÉ du guide, collé comme le PO ─────
const RACINE = process.cwd();
const T1_LIVRE = readFileSync(join(RACINE, 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
const GUIDE = readFileSync(join(RACINE, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
const ANCRE = 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.';
const BLOC_52 = (() => {
  const m = /<!-- c839:bloc-52-revise -->\s*\n```text\n([\s\S]*?)\n```/.exec(GUIDE);
  if (!m) throw new Error('bloc 52 révisé absent du guide');
  return m[1];
})();
const T1_AVEC_BLOC_52 = T1_LIVRE.replace(ANCRE, `${BLOC_52}\n\n${ANCRE}`);

/** Sortie maître T1 (ANALYZE_DOCUMENT) d'une facture d'achat avec garantie. */
function sortie(o: { identity?: unknown; nom?: string; objet?: string; texte?: string[] } = {}): Record<string, unknown> {
  const nom = o.nom ?? NOM_LU;
  const objet = o.objet ?? OBJET;
  const ev = (excerpt: string) => ({ excerpt, page: 1 });
  return {
    task: 'ANALYZE_DOCUMENT',
    document: {
      title: { value: 'Facture', confidence: 'certain', evidence: ev('FACTURE') },
      documentDate: { value: EMISSION, confidence: 'certain', evidence: ev('Date : 14/11/2026') },
      supplier: { name: nom, confidence: 'certain', evidence: { excerpt: LIGNE_EMETTEUR }, ...(o.identity !== undefined ? { identity: o.identity } : {}) },
      amountCents: { value: 46999, confidence: 'certain', evidence: ev('TOTAL TTC 469,99 €') },
      classification: { canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'FACTURE', confidence: 0.95, evidence: { excerpt: 'FACTURE' } },
    },
    entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
    transcription: ['FACTURE', LIGNE_EMETTEUR, 'Date : 14/11/2026', `${objet} 1 x 469,99 €`, LIGNE_GARANTIE, 'TOTAL TTC 469,99 €', ...(o.texte ?? [])].join('\n'),
    tables: [],
    facts: [{
      canonicalKey: null, rawKey: 'period.warranty', label: 'Garantie', subject: objet, attribute: null,
      rawValue: '14/11/2026 au 14/11/2028', normalizedValue: `${GARANTIE.s}/${GARANTIE.e}`, valueType: 'string', canonicalUnit: null,
      target: { type: 'DOCUMENT', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: ev(LIGNE_GARANTIE),
      periodStart: GARANTIE.s, periodEnd: GARANTIE.e,
    }],
    hasExploitableContent: true,
  };
}

scenario('C839', 'Pipeline fournisseur et nommage des périodes, titres et reprises (#839)', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState();
  let k: OperationsKit;

  async function prompt(porte: boolean) {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: porte ? 98392 : 98391, treatment: 'T1', versionNumber: porte ? 8392 : 8391, content: porte ? T1_AVEC_BLOC_52 : T1_LIVRE }]);
    (await import('@/services/ai/source-analysis/supplier-identity/contract')).__resetSupplierIdentityCapabilityCacheForTests();
  }
  beforeAll(() => { k = operationsKit(sql, make); });
  beforeEach(async () => { delete process.env.T1_SUPPLIER_IDENTITY_ENABLED; await prompt(true); });
  afterAll(async () => {
    delete process.env.T1_SUPPLIER_IDENTITY_ENABLED;
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  const svc = () => import('@/services/documents/document-title.service');
  const deposer = async (c: AccountRow) => {
    const f = await make.assetFile(c, { assetId: null });
    const nom = `scan-${f.id}.pdf`;
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${nom}, filename = ${nom}, retained_title = ${nom},
                analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const analyser = async (c: AccountRow, fileId: number, output: Record<string, unknown>, extra: RecordedOutput[] = []) => {
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${fileId}`;
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, repeat: true }, ...extra]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], c.id, { userId: c.ownerUserId, billable: false, origin: 'e2e/c839' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const etat = (fileId: number) => sql<Json[]>`
    SELECT retained_title, title_source, supplier, title_rule_version::int AS rule_version, title_convention,
           title_basis -> 'billedPeriod' AS billed, title_basis ->> 'supplier' AS basis_supplier
      FROM asset_files WHERE id = ${fileId}`.then((r) => r[0]);
  const resultat = async (fileId: number): Promise<Json> => {
    const [r] = await sql<{ raw: string }[]>`SELECT raw_response_json AS raw FROM document_analysis_runs
      WHERE asset_file_id = ${fileId} AND status = 'completed' AND raw_response_json IS NOT NULL ORDER BY is_current_reference DESC, id DESC LIMIT 1`;
    return JSON.parse(r.raw);
  };
  const evenements = (fileId: number) => sql<Json[]>`
    SELECT origin, outcome, reason, old_title, new_title, rule_version FROM document_title_events WHERE file_id = ${fileId} ORDER BY id`;
  const periodes = (fileId: number) => sql<Json[]>`
    SELECT period_kind AS kind, start_on::text AS s, end_on::text AS e FROM document_business_periods WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY period_kind`;
  const nommer = async (c: AccountRow, fileId: number, mode: 'refresh' | 'repair' = 'repair') =>
    (await svc()).ensureBusinessTitle({ fileId, accountId: c.id, origin: mode === 'repair' ? 'COHERENCE' : 'T1', mode });

  // ══ E1 — identité de l'émetteur, de bout en bout ═════════════════════════

  it('C839-E2E-01 — identité PROUVÉE : contrat → schéma fournisseur → projection → raw_response_json → titre persisté + événement', async () => {
    const c = await make.account({ plan: 'premium' });
    const id = await deposer(c);
    await analyser(c, id, sortie({ identity: IDENTITE }));

    // Schéma de sortie TRANSMIS au fournisseur (structured output) : la rubrique y figure.
    const appel = replay.calls.find((x) => x.operationCode === 't1_analyze_document');
    expect(appel).toBeDefined();
    if (appel!.responseSchema !== undefined) expect(JSON.stringify(appel!.responseSchema)).toContain('"identity"');
    expect(appel!.prompt).toContain('contrat t1-supplier-identity-v1');

    // Persistance : entrée maître `supplier.identity` → résultat `supplier.value.identity`, contrôle conservé.
    const raw = await resultat(id);
    expect(raw.document.supplier.value.name).toBe(NOM_LU);
    expect(raw.document.supplier.value.identity).toMatchObject({
      legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: 'Chasse S/R', confidence: 'certain',
      evidence: { quote: LIGNE_EMETTEUR, page: 1 },
      verification: { status: 'VERIFIED', textOrigin: 'T1_TRANSCRIPTION', proven: { tradeName: true, legalName: true }, checks: [], contract: { carried: true } },
    });

    // Relecture des données PERSISTÉES par le service de nommage (T3 / cohérence) : enseigne prouvée.
    const inputs = await (await svc()).loadPersistedTitleInputs(id, c.id);
    expect(inputs?.ctx.supplier).toBe('Conforama');

    // Titre : nature + objet + enseigne + date du document ; ni établissement, ni plage de garantie.
    const t = await etat(id);
    expect(t.retained_title).toBe(TITRE_ENSEIGNE);
    expect(t.retained_title).not.toMatch(/2028|Chasse|France SA/);
    expect(t).toMatchObject({ title_source: 'SYSTEM', rule_version: 6, title_convention: null, billed: null, basis_supplier: 'Conforama' });
    expect((await evenements(id)).filter((e) => e.outcome === 'UPDATED').at(-1)).toMatchObject({ origin: 'T1', new_title: TITRE_ENSEIGNE, rule_version: 6 });

    // Données fournisseur d'origine inchangées ; aucun fournisseur « enseigne » créé ou renommé.
    const [x] = await sql<Json[]>`SELECT supplier_name FROM document_extractions WHERE file_id = ${id}`;
    expect(x.supplier_name).toBe(NOM_LU);
    expect(t.supplier ?? NOM_LU).not.toBe('Conforama');
    expect(await sql`SELECT 1 FROM suppliers WHERE account_id = ${c.id} AND lower(name) = 'conforama'`).toHaveLength(0);
    // La garantie reste une période STRUCTURÉE du document (affichée, éditable).
    expect(await periodes(id)).toEqual([{ kind: 'WARRANTY', s: GARANTIE.s, e: GARANTIE.e }]);
    // Un second contrôle ne change rien (empreinte du contexte, version des règles à jour).
    expect((await nommer(c, id)).outcome).toBe('NO_CHANGE');
  });

  it('C839-E2E-02 — identité ABSENTE : le nom lu, sans coupe ; ancienne forme `evidence.quote` du bloc 52 acceptée', async () => {
    const c = await make.account({ plan: 'premium' });
    const sans = await deposer(c);
    await analyser(c, sans, sortie());
    expect((await resultat(sans)).document.supplier.value.identity).toBeUndefined();
    expect((await etat(sans)).retained_title).toBe(TITRE_NOM_LU);

    const ancienneForme = await deposer(c);
    await analyser(c, ancienneForme, sortie({ identity: { ...IDENTITE, evidence: { quote: LIGNE_EMETTEUR } } }));
    expect((await resultat(ancienneForme)).document.supplier.value.identity.evidence.quote).toBe(LIGNE_EMETTEUR);
    expect((await etat(ancienneForme)).retained_title).toBe(TITRE_ENSEIGNE);
  });

  it('C839-E2E-03 — identité MAL FORMÉE : retirée seule, l’analyse réussit, le titre garde le nom lu', async () => {
    const c = await make.account({ plan: 'premium' });
    for (const faux of ['Conforama France SA', { tradeName: 'Conforama' }]) {
      const id = await deposer(c);
      await analyser(c, id, sortie({ identity: faux }));
      const raw = await resultat(id);
      expect(raw.document.supplier.value, JSON.stringify(faux)).toMatchObject({ name: NOM_LU });
      expect(raw.document.supplier.value.identity).toBeUndefined();
      expect((await etat(id)).retained_title).toBe(TITRE_NOM_LU);
    }
  });

  it('C839-E2E-04 — citation NON VÉRIFIABLE, confiance FAIBLE : identité conservée avec son motif, jamais dans le titre', async () => {
    const c = await make.account({ plan: 'premium' });
    const introuvable = await deposer(c);
    await analyser(c, introuvable, sortie({ identity: { ...IDENTITE, evidence: { excerpt: 'CONFORAMA - Magasin de Lyon Part-Dieu' } } }));
    expect((await resultat(introuvable)).document.supplier.value.identity.verification).toMatchObject({ status: 'UNVERIFIED', checks: ['QUOTE_NOT_IN_SOURCE', 'NO_PROVEN_NAME'] });
    expect((await etat(introuvable)).retained_title).toBe(TITRE_NOM_LU);

    const faible = await deposer(c);
    await analyser(c, faible, sortie({ identity: { ...IDENTITE, confidence: 'probable' } }));
    const v = (await resultat(faible)).document.supplier.value.identity;
    expect(v).toMatchObject({ tradeName: 'Conforama', establishment: 'Chasse S/R', verification: { status: 'UNVERIFIED' } });
    expect(v.verification.checks).toContain('LOW_CONFIDENCE');
    expect((await etat(faible)).retained_title).toBe(TITRE_NOM_LU);
  });

  it('C839-E2E-05 — prompt actif SANS le bloc 52, coupure d’urgence à l’analyse puis à la reprise : nom lu', async () => {
    const c = await make.account({ plan: 'premium' });
    await prompt(false);
    const horsContrat = await deposer(c);
    await analyser(c, horsContrat, sortie({ identity: IDENTITE }));
    expect((await resultat(horsContrat)).document.supplier.value.identity.verification).toMatchObject({
      status: 'UNVERIFIED', checks: ['CONTRACT_NOT_CARRIED'], contract: { carried: false, reason: 'MARKER_MISSING' },
    });
    expect((await etat(horsContrat)).retained_title).toBe(TITRE_NOM_LU);

    await prompt(true);
    process.env.T1_SUPPLIER_IDENTITY_ENABLED = '0';
    (await import('@/services/ai/source-analysis/supplier-identity/contract')).__resetSupplierIdentityCapabilityCacheForTests();
    const coupe = await deposer(c);
    await analyser(c, coupe, sortie({ identity: IDENTITE }));
    expect((await resultat(coupe)).document.supplier.value.identity.verification.contract).toMatchObject({ carried: false, reason: 'DISABLED' });
    expect((await etat(coupe)).retained_title).toBe(TITRE_NOM_LU);

    // Coupure posée APRÈS une identité vérifiée : la reprise ramène le titre au nom lu (aucune donnée à corriger).
    delete process.env.T1_SUPPLIER_IDENTITY_ENABLED;
    (await import('@/services/ai/source-analysis/supplier-identity/contract')).__resetSupplierIdentityCapabilityCacheForTests();
    const verifiee = await deposer(c);
    await analyser(c, verifiee, sortie({ identity: IDENTITE }));
    expect((await etat(verifiee)).retained_title).toBe(TITRE_ENSEIGNE);
    process.env.T1_SUPPLIER_IDENTITY_ENABLED = '0';
    expect((await nommer(c, verifiee)).outcome).toBe('UPDATED');
    expect((await etat(verifiee)).retained_title).toBe(TITRE_NOM_LU);
    // L'identité reste enregistrée telle quelle (rien n'est perdu).
    expect((await resultat(verifiee)).document.supplier.value.identity.verification.status).toBe('VERIFIED');
  });

  it('C839-E2E-06 — rejeu : seconde analyse identique puis contrôle — titre inchangé, aucun événement de plus, champs conservés', async () => {
    const c = await make.account({ plan: 'premium' });
    const id = await deposer(c);
    await analyser(c, id, sortie({ identity: IDENTITE }));
    const misAJour = async () => (await evenements(id)).filter((e) => e.outcome === 'UPDATED').length;
    const avant = await misAJour();
    await analyser(c, id, sortie({ identity: IDENTITE }));
    expect((await etat(id)).retained_title).toBe(TITRE_ENSEIGNE);
    expect((await nommer(c, id)).outcome).toBe('NO_CHANGE');
    expect(await misAJour()).toBe(avant);
    const identite = (await resultat(id)).document.supplier.value.identity;
    expect(identite).toMatchObject({ legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: 'Chasse S/R', evidence: { quote: LIGNE_EMETTEUR } });
  });

  // ══ E2 — éligibilité temporelle : faits, replis, T3 ══════════════════════

  /** Achat (candidat Opération sans période, sauf `hints`). */
  const achat = (assetId: number, hints: AnchoredOperationCandidate['financialHints'] = []): AnchoredOperationCandidate => cand({
    typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Vendeur', summary: OBJET,
    targetHints: [cible(assetId)], temporalHints: {}, financialHints: hints,
  });
  /** Facture persistée (faits, candidats, run T1 de référence) — l'état qu'une analyse T1 laisse en base. */
  async function facture(c: AccountRow, o: {
    faits?: Array<[string, string | null, string | null]>; hints?: AnchoredOperationCandidate['financialHints'];
    billingPeriod?: { start: string; end: string } | null; objet?: string; fournisseur?: string; qualifier?: boolean;
  } = {}) {
    const m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const id = await k.document(c, m.id, [achat(m.id, o.hints ?? [])], { type: 'INVOICE', title: 'Facture', amountCents: 46999, date: EMISSION });
    const fournisseur = o.fournisseur ?? 'Vendeur Exemple';
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED', supplier = ${fournisseur}, analysis_state = 'ANALYZED', title_source = 'SYSTEM',
                     original_filename = ${`scan-${id}.pdf`}, last_analysis_at = now() - interval '1 hour' WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = 'Facture', supplier_name = ${fournisseur}, document_date = ${EMISSION} WHERE file_id = ${id}`;
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${id}`;
    for (const [key, debut, fin] of o.faits ?? [['period.warranty', GARANTIE.s, GARANTIE.e]]) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, subject, normalized_value, period_start, period_end, confidence, excerpt, status)
                VALUES (${c.id}, ${id}, ${x.id}, ${key}, ${key}, ${o.objet ?? OBJET}, ${`${debut}/${fin}`}, ${debut}, ${fin}, 'certain', ${`extrait ${key}`}, 'active')`;
    }
    const raw = { document: {
      title: { value: 'Facture', confidence: 'certain' }, type: { value: 'FACTURE', confidence: 'certain' }, date: { value: EMISSION, confidence: 'certain' },
      supplier: { value: { name: fournisseur }, confidence: 'certain', excerpt: fournisseur },
      ...(o.billingPeriod ? { billingPeriod: { ...o.billingPeriod, principalMonth: null, principalMonthBasis: null, confidence: 'certain', evidence: { quote: 'Période', page: 1 } } } : {}),
    }, extractedFields: [{ subject: o.objet ?? OBJET }] };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${id}, ${`h${id}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${c.id}, ${JSON.stringify(raw)})`;
    if (o.qualifier !== false) await (await import('@/services/documents/business-periods/service')).refreshDocumentBusinessPeriods(c.id, id);
    return id;
  }

  it('C839-E2E-10 — garantie présentée à tort en `document.billingPeriod` puis en `financialHints` : jamais la période du titre', async () => {
    const c = await make.account({ plan: 'premium' });
    const viaT1 = await facture(c, { billingPeriod: { start: GARANTIE.s, end: GARANTIE.e } });
    expect((await nommer(c, viaT1, 'refresh')).outcome).toBe('UPDATED');
    const a = await etat(viaT1);
    expect(a.retained_title).toBe(`Facture ${OBJET} Vendeur Exemple — 14 novembre 2026`);
    expect(a).toMatchObject({ billed: null, title_convention: null });

    const viaHints = await facture(c, { hints: [fh('REALIZED_COST', 46999, { periodStart: GARANTIE.s, periodEnd: GARANTIE.e, economicDate: EMISSION })] });
    expect((await nommer(c, viaHints, 'refresh')).outcome).toBe('UPDATED');
    expect((await etat(viaHints)).retained_title).not.toMatch(/2028/);
    expect((await etat(viaHints)).billed).toBeNull();
    // Les données structurées gardent la garantie (rien n'est supprimé).
    expect((await periodes(viaHints)).map((p) => p.kind)).toContain('WARRANTY');
  });

  it('C839-E2E-11 — qualification ILLISIBLE : abstention, fait conservé ; fait de période non typé lisible : comportement d’avant', async () => {
    const c = await make.account({ plan: 'premium' });
    // Fait générique (clé hors référentiel) qui porte une période : sa nature n'est pas établie par sa clé.
    const illisible = await facture(c, { faits: [['info.periode', '2026-11-01', '2026-11-30']], qualifier: false });
    await sql`ALTER TABLE document_business_periods RENAME TO document_business_periods_c839`;
    try {
      expect((await nommer(c, illisible, 'refresh')).outcome).toBe('UPDATED');
      // Abstention : la période ambiguë ne nomme pas ; la date du document reste.
      expect((await etat(illisible)).retained_title).toBe(`Facture ${OBJET} Vendeur Exemple — 14 novembre 2026`);
    } finally {
      await sql`ALTER TABLE document_business_periods_c839 RENAME TO document_business_periods`;
    }
    // Le fait n'a jamais été supprimé.
    expect(await sql`SELECT 1 FROM document_facts WHERE file_id = ${illisible} AND raw_key = 'info.periode' AND status = 'active'`).toHaveLength(1);
    // Qualification LISIBLE, aucune nature exclue sur ces bornes : la période nomme, comme avant la carte.
    const lisible = await facture(c, { faits: [['info.periode', '2026-11-01', '2026-11-30']], qualifier: false });
    expect((await nommer(c, lisible, 'refresh')).outcome).toBe('UPDATED');
    expect((await etat(lisible)).retained_title).toContain('Novembre 2026');
  });

  it('C839-E2E-12 — garantie + vraie période facturée (bornes différentes, puis identiques) ; abonnement mensuel inchangé', async () => {
    const c = await make.account({ plan: 'premium' });
    const differentes = await facture(c, { faits: [['period.warranty', GARANTIE.s, GARANTIE.e], ['period.billing', '2026-11-01', '2026-11-30']] });
    await nommer(c, differentes, 'refresh');
    expect((await etat(differentes)).retained_title).toContain('Novembre 2026');
    expect((await etat(differentes)).retained_title).not.toMatch(/2028/);

    // Mêmes bornes établies INDÉPENDAMMENT comme période facturée : la période reste admise.
    const identiques = await facture(c, { faits: [['period.warranty', GARANTIE.s, GARANTIE.e], ['period.billing', GARANTIE.s, GARANTIE.e]] });
    await nommer(c, identiques, 'refresh');
    expect((await etat(identiques)).billed).toMatchObject({ start: GARANTIE.s, end: GARANTIE.e });

    const m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const mensuelle = await k.document(c, m.id, [cand({
      typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Homiris', summary: 'Abonnement télésurveillance',
      targetHints: [cible(m.id)], businessReferences: [ref('INVOICE', 'F-2026-02')] as AnchoredOperationCandidate['businessReferences'],
      temporalHints: { startDate: '2026-02-01', endDate: '2026-02-28' },
      financialHints: [fh('REALIZED_COST', 3990, { amountScope: 'INSTALLMENT', economicDate: '2026-02-01', periodStart: '2026-02-01', periodEnd: '2026-02-28' })],
    })], { type: 'INVOICE', title: 'Facture', amountCents: 3990, date: '2026-02-06' });
    await sql`UPDATE asset_files SET supplier = 'HOMIRIS', analysis_state = 'ANALYZED', last_analysis_at = now() - interval '1 hour' WHERE id = ${mensuelle}`;
    await sql`UPDATE document_extractions SET title = 'Facture', supplier_name = 'HOMIRIS', document_date = '2026-02-06' WHERE file_id = ${mensuelle}`;
    await nommer(c, mensuelle, 'refresh');
    expect(await etat(mensuelle)).toMatchObject({ retained_title: 'Facture Homiris — Février 2026', title_convention: 'PERIODIC' });
  });

  it('C839-E2E-13 — T3 : une proposition reprenant la garantie est refusée sur les données réelles du document', async () => {
    const c = await make.account({ plan: 'premium' });
    const id = await facture(c);
    await nommer(c, id, 'refresh');
    const nom = (await etat(id)).retained_title as string;
    const repo = await import('@/services/ai/reconciliation/document-naming/repository');
    const { judgeProposal } = await import('@/services/ai/reconciliation/document-naming/guards');
    const known = await repo.loadKnownData(c.id, {
      id, name: nom, originalName: `scan-${id}.pdf`, filename: null, s3Key: null, publicId: null, titleSource: 'SYSTEM', legacyUserEdit: false,
      typeCode: 'INVOICE', supplier: 'Vendeur Exemple', documentDate: EMISSION, assetId: null, assetName: null, extractionId: null, extractedAt: null,
      extractionTitle: 'Facture', amountCents: 46999,
    } as never);
    expect(known.excludedDays).toEqual([GARANTIE.e]);
    expect(known.periods).toEqual([]);
    const juger = (proposed: string) => judgeProposal({ document_id: id, expected_current_name: nom, proposed_name: proposed, reason: 'harmonisation', confidence: 'certain' },
      { docs: new Map([[id, { id, name: nom, origin: 'T1' as const, fingerprint: 'f' }]]), seen: new Set(), known, now: new Date(), cooldownDays: 30 });
    expect(juger(`Facture ${OBJET} Vendeur Exemple — 14 novembre 2026 au 14 novembre 2028`)).toMatchObject({ accept: false, code: 'EXCLUDED_PERIOD_PROPOSED' });
    expect(juger(`Achat ${OBJET} — Vendeur Exemple — 14 novembre 2026`)).toMatchObject({ accept: true });
  });

  // ══ E3 / E4 — qualité, reprise, traçabilité ══════════════════════════════

  it('C839-E2E-14 — titres longs : le modèle n’est jamais coupé, les accessoires sont retirés, limite commune à T3', async () => {
    const c = await make.account({ plan: 'premium' });
    const MODELE = 'Réfrigérateur combiné Samsung RF65DG960ESG Bespoke AI Family Hub+ inox 645 litres';
    const id = await facture(c, { objet: MODELE, fournisseur: 'Grand Magasin Électroménager Lyon Part-Dieu' });
    await nommer(c, id, 'refresh');
    const t = (await etat(id)).retained_title as string;
    expect(t).toBe(`Facture ${MODELE} — 14 novembre 2026`);
    const { DOCUMENT_TITLE_MAX_LENGTH } = await import('@/lib/documents/document-title-rules');
    expect(t.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX_LENGTH);
  });

  it('C839-E2E-15 — reprise COH-DOC-TITLES : simulation, réparation motivée, USER et legacy protégés, A ≠ B, idempotente', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const ANCIEN = 'Facture Vendeur Exemple — 14 novembre 2026 au 14 novembre 2028';
    const TRONQUE = 'Facture Réfrigérateur combiné Samsung RF65DG960ESG Bespoke AI Family Hub+ inox 645';
    const garantie = await facture(a);
    const tronque = await facture(a, { objet: 'Réfrigérateur combiné Samsung RF65DG960ESG Bespoke AI Family Hub+ inox 645 litres', fournisseur: 'Grand Magasin Électroménager Lyon Part-Dieu' });
    const utilisateur = await facture(a);
    const legacy = await facture(a);
    const autreCompte = await facture(b);
    const v5 = async (id: number, titre: string) => sql`UPDATE asset_files SET retained_title = ${titre}, title_source = 'SYSTEM', title_rule_version = 5,
                       title_context_fingerprint = 'v5', title_checked_at = now() - interval '2 days' WHERE id = ${id}`;
    for (const id of [garantie, utilisateur, legacy, autreCompte]) await v5(id, ANCIEN);
    await v5(tronque, TRONQUE);
    await sql`UPDATE asset_files SET retained_title = 'Ma table', title_source = 'USER' WHERE id = ${utilisateur}`;
    await sql`UPDATE asset_files SET retained_title = 'Table du salon', user_edited_fields = '{"retainedTitle": true}'::jsonb WHERE id = ${legacy}`;
    const evAvant = Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_title_events WHERE account_id = ${a.id}`)[0].n);

    // Simulation : signalés, rien n'est écrit (ni titre, ni événement), aucun appel IA.
    const appelsT1 = () => replay.calls.filter((x) => x.operationCode === 't1_analyze_document').length;
    const appelsAvant = appelsT1();
    const blanc = await runCoherenceFor(sql, [a.id], { mode: 'DRY_RUN' });
    expect(blanc.results['COH-DOC-TITLES']?.WOULD_REPAIR).toBeGreaterThanOrEqual(2);
    expect(await proofOf(sql, a.id, 'COH-DOC-TITLES', garantie)).toMatchObject({ last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN' });
    expect((await etat(garantie)).retained_title).toBe(ANCIEN);
    expect((await etat(tronque)).retained_title).toBe(TRONQUE);
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_title_events WHERE account_id = ${a.id}`)[0].n)).toBe(evAvant);

    // Réparation : titres automatiques recomposés, motifs journalisés dans la même transaction.
    const correctif = await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE' });
    expect(correctif.results['COH-DOC-TITLES']?.REPAIRED).toBeGreaterThanOrEqual(2);
    expect((await etat(garantie)).retained_title).toBe(`Facture ${OBJET} Vendeur Exemple — 14 novembre 2026`);
    expect((await evenements(garantie)).at(-1)).toMatchObject({ origin: 'COHERENCE', outcome: 'UPDATED', reason: 'EXCLUDED_PERIOD_REMOVED', old_title: ANCIEN, rule_version: 6 });
    expect((await etat(tronque)).retained_title).toBe('Facture Réfrigérateur combiné Samsung RF65DG960ESG Bespoke AI Family Hub+ inox 645 litres — 14 novembre 2026');
    // Titres de l'utilisateur intacts (USER, et ancienne marque du tiroir promue USER).
    expect(await etat(utilisateur)).toMatchObject({ retained_title: 'Ma table', title_source: 'USER' });
    expect((await etat(legacy)).retained_title).toBe('Table du salon');
    // Compte B : hors du périmètre de la campagne, jamais touché.
    expect(await etat(autreCompte)).toMatchObject({ retained_title: ANCIEN, rule_version: 5 });
    // Aucune analyse T1 supplémentaire (reprise déterministe, sans IA d'extraction).
    expect(appelsT1()).toBe(appelsAvant);

    // Idempotence : un second passage ne réécrit AUCUN titre. Seule l'ancienne marque du tiroir, promue USER au
    // premier passage (règle du lot 33C, inchangée), reçoit ses données de nommage ; un troisième passage : rien.
    const titres = async () => Promise.all([garantie, tronque, utilisateur, legacy].map(async (id) => (await etat(id)).retained_title));
    const avantSecond = await titres();
    const second = await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE' });
    const repares = await sql<{ id: number }[]>`SELECT object_id::int AS id FROM coherence_object_proofs
      WHERE account_id = ${a.id} AND check_id = 'COH-DOC-TITLES' AND last_campaign_id = ${second.campaignId} AND last_result = 'REPAIRED'`;
    expect(repares.map((r) => r.id).filter((id) => id !== legacy)).toEqual([]);
    expect(await titres()).toEqual(avantSecond);
    const troisieme = await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE' });
    expect(troisieme.results['COH-DOC-TITLES']?.REPAIRED ?? 0).toBe(0);
    expect((await nommer(a, garantie)).outcome).toBe('NO_CHANGE');
  });

  it('C839-E2E-16 — journalisation en échec : le titre n’est PAS écrit sans son événement (même transaction), issue FAILED', async () => {
    const c = await make.account({ plan: 'premium' });
    const id = await facture(c);
    await sql`UPDATE asset_files SET retained_title = ${`scan-${id}.pdf`}, title_rule_version = NULL, title_context_fingerprint = NULL WHERE id = ${id}`;
    await sql.unsafe(`CREATE OR REPLACE FUNCTION c839_refus_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.file_id = ${id} AND NEW.outcome = 'UPDATED' THEN RAISE EXCEPTION 'journal indisponible (e2e)'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER c839_refus_journal BEFORE INSERT ON document_title_events FOR EACH ROW EXECUTE FUNCTION c839_refus_journal()`);
    try {
      const r = await nommer(c, id, 'refresh');
      expect(r.outcome).toBe('FAILED');
      expect(r.reason).toMatch(/^TITLE_EVENT_NOT_RECORDED/);
      // Aucune écriture du titre : transaction annulée.
      expect(await etat(id)).toMatchObject({ retained_title: `scan-${id}.pdf`, rule_version: null });
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS c839_refus_journal ON document_title_events');
      await sql.unsafe('DROP FUNCTION IF EXISTS c839_refus_journal()');
    }
    // Journal rétabli : le titre est écrit AVEC son événement.
    expect((await nommer(c, id, 'refresh')).outcome).toBe('UPDATED');
    const t = (await etat(id)).retained_title;
    expect((await evenements(id)).filter((e) => e.outcome === 'UPDATED').at(-1)).toMatchObject({ new_title: t });
  });
});
