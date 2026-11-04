/**
 * Lot 109K — ticket « T1 couverture PDF + propagation des réparations T1 vers
 * les candidats / T3 » (COR-01, COR-02, REC-01) — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : extract brut (`ensureRawExtract`, octets d'un PDF
 * CID réel), couche A (`writeSourceLayer`), contrôle de cohérence
 * COH-T1-PDF-COVERAGE par le moteur (`controlObjects`), persistance T1 des
 * candidats (`replaceOperationCandidates`), ajout de faits réparés
 * (`appendRepairedFacts` → propagation), consolidation T3 réelle
 * (`consolidateAccountOperations`, M3 coupé). Aucun appel IA.
 *
 *   L109K-E2E-COV  stock : PDF CID « vérification incomplète » (ancienne sonde) → confronté à l'extract
 *                  pdf.js persisté → VERIFIED, état recalculé ; rejoué : aucune écriture. Scan : reste
 *                  VERIFICATION_INCOMPLETE, motif exact par page.
 *   L109K-E2E-REC  devis sans montant → T3 (événement prévu) ; réparation sans incidence : aucune
 *                  réévaluation ; réparation « Total TTC 880 € » : candidat supersédé (traçable), T3 une
 *                  fois, 880 € PRÉVUS seulement ; rejouée : aucune version, aucun signal ; facture puis
 *                  rapport d'intervention : même événement, 880 € réalisés une seule fois ; réanalyse
 *                  identique : aucun nouvel objet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';
import type { T1Fact } from '@/services/ai/source-analysis/master/t1-contract';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJ = '2026-11-04';
const CHECK = 'COH-T1-PDF-COVERAGE';
const FIX = join(process.cwd(), 'src/services/ai/source-analysis/source-units/__tests__/fixtures/pdf-coverage');
const PAGE1 = 'Devis numero DV-2026-0042\nEntreprise Exemple Charpente, douze rue des Artisans, Lyon\nClient : Madame Exemple, maison principale\n'
  + 'Traitement preventif des charpentes et solives\nDeplacement et installation du chantier\nTotal HT 733,33 EUR, TVA 146,67 EUR, Total TTC 880,00 EUR';
const PAGE2 = 'Conditions generales de vente\nValidite du devis trois mois a compter de son emission\nAcompte de trente pourcent exigible a la commande\n'
  + 'Garantie decennale souscrite aupres d un assureur mutualiste\nReglement par virement bancaire sous quinze jours';

scenario('L109K', 'T1 — couverture PDF fiabilisée et réparations propagées vers les candidats et T3', ({ sql, make }) => {
  const k = operationsKit(sql, make);

  /** Document déjà analysé AVANT le lot 109K : extract pdf.js persisté, couche A, couverture « vérification incomplète ». */
  async function stockIncomplet(compte: AccountRow, fichier: string, transcription: string): Promise<number> {
    const f = await make.assetFile(compte, {});
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const bytes = new Uint8Array(readFileSync(join(FIX, fichier)));
    const { ensureRawExtract } = await import('@/services/ai/source-analysis/raw-extract/raw-extract.service');
    const r = await ensureRawExtract({ accountId: compte.id, fileId: f.id, url: `https://stockage.e2e/l109k/${f.id}.pdf`, mimeType: 'application/pdf', fetchBytes: async () => bytes });
    expect(r.error).toBeNull();
    const { buildSourceUnits } = await import('@/services/ai/source-analysis/source-units/build-units');
    const { computeCoverage, buildCompletenessReport } = await import('@/services/ai/source-analysis/source-units/coverage');
    const { writeSourceLayer } = await import('@/services/ai/source-analysis/source-units/repository');
    const units = buildSourceUnits({ segments: [{ text: transcription, pageOffset: 0, origin: 'PASS_1' }], tables: [], visual: null, document: undefined as never, gaps: [] });
    const cov = computeCoverage(units, { facts: [], metadataUnitIds: new Set(units.map((u) => u.sourceUnitId)) });
    // Vérification telle que l'ancienne sonde l'enregistrait : pages non vérifiées, sans verdict par page.
    const report = buildCompletenessReport(cov, {
      factsCount: 4, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0, warningCodes: [], retryAllowed: true,
      verification: { status: 'PARTIAL', reason: 'pages_unverified', pagesExpected: 2, verified: [], missing: [], unverified: [1, 2], scanned: fichier === 'scanne.pdf' ? [1, 2] : [] },
    });
    expect(report.qualityState).toBe('VERIFICATION_INCOMPLETE');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await writeSourceLayer(tx as never, { accountId: compte.id, fileId: f.id, extractionId: x.id, layer: { layerVersion: 1, units: cov, unresolvedFacts: [], report, retryable: false } });
    });
    await sql`UPDATE document_extraction_coverage SET next_retry_at = NULL WHERE file_id = ${f.id}`;
    return f.id;
  }
  const controler = async (compte: AccountRow, ids: number[]) => {
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    return controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode: 'CORRECTIVE', correlationId: `coherence:e2e-109k:${CHECK}` },
      check: getCheck(CHECK)!, accountId: compte.id, ids, trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
  };
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT quality_state, source_verification, verification, last_retry_result, updated_at FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];

  it('L109K-E2E-COV — stock CID re-vérifié sans IA (VERIFIED), scan conservé incomplet avec motif exact, aucune reconfrontation', async () => {
    const compte = await make.account({ plan: 'premium' });
    const cid = await stockIncomplet(compte, 'police-cid.pdf', `${PAGE1}\n${PAGE2}`);
    const scan = await stockIncomplet(compte, 'scanne.pdf', `${PAGE1}\n${PAGE2}`);
    const omis = await stockIncomplet(compte, 'police-cid.pdf', PAGE1);
    await controler(compte, [cid, scan, omis]);

    const c = await couverture(cid);
    expect(c.quality_state).not.toBe('VERIFICATION_INCOMPLETE');
    expect(c.source_verification).toBe('VERIFIED');
    expect(c.verification.verifierVersion).toBe(2);
    expect(c.verification.pageDetails.map((d: Json) => [d.page, d.status, d.method])).toEqual([[1, 'VERIFIED', 'PDF_TEXT_LAYER'], [2, 'VERIFIED', 'PDF_TEXT_LAYER']]);
    expect(c.last_retry_result).toBe('REVERIFIED_VERIFIED');

    const s = await couverture(scan);
    expect(s.quality_state).toBe('VERIFICATION_INCOMPLETE');
    expect(s.verification.pageDetails.every((d: Json) => d.status === 'UNVERIFIABLE' && d.reason === 'scanned_no_text_layer')).toBe(true);
    const { verificationFollowup } = await import('@/services/ai/source-analysis/source-units/verification-followup');
    const suivi = verificationFollowup({ qualityState: s.quality_state, sourceVerification: s.source_verification, verificationReason: s.verification.verificationReason,
      pagesUnverified: s.verification.pagesUnverified, pageDetails: s.verification.pageDetails })!;
    expect(suivi.reason).toContain('page scannée');
    expect(suivi.autoRetry).toBe(false);

    // Omission objectivée : page 2 MANQUANTE (jamais « vérifiée »), relecture ciblée demandée à la file T1 (bornée).
    const o = await couverture(omis);
    expect(o.verification.pagesMissing).toEqual([2]);
    expect(o.quality_state).not.toBe('COMPLETE');

    // Rejoué : CONSISTENT, aucune écriture (empreinte, version des règles).
    const avant = [await couverture(cid), await couverture(scan)].map((x) => String(x.updated_at));
    await controler(compte, [cid, scan]);
    expect([await couverture(cid), await couverture(scan)].map((x) => String(x.updated_at))).toEqual(avant);
  });

  it('L109K-E2E-REC — devis → réparation → facture → intervention : 880 € prévus puis réalisés une fois, propagation dédoublonnée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const commun = { provider: 'Charpentes Exemple', targetHints: [cible(maison.id)], typeHint: 'INTERVENTION' as const, summary: 'Traitement des charpentes' };
    // 1. Devis analysé : candidat établi SANS montant (information non lue à l'analyse initiale).
    const devis = await k.document(compte, maison.id, [cand({ ...commun, sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', businessReferences: [ref('QUOTE', 'DV-2026-0042')] })],
      { type: 'QUOTE', title: 'Devis traitement charpente', date: '2026-10-20' });
    await k.passer(compte);
    const ops0 = await k.actives(compte);
    expect(ops0).toHaveLength(1);
    expect(ops0[0].status).toBe('ENVISAGED');
    expect(await k.composantes(ops0[0].id)).toEqual([]);

    const { appendRepairedFacts } = await import('@/services/ai/source-analysis/source-units/jobs');
    const { SourceUnitLinker } = await import('@/services/ai/source-analysis/source-units/coverage');
    const [{ id: extractionId }] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${devis}`;
    const fait = (label: string, value: string, page = 1): T1Fact => ({
      canonicalKey: null, rawKey: label, label, rawValue: value, normalizedValue: value,
      target: { type: 'DOCUMENT', entityId: null, confidence: 'certain', evidenceSignals: [] },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: `${label} ${value}`, page },
    } as T1Fact);
    const reparer = (facts: T1Fact[]) => appendRepairedFacts({ fileId: devis, accountId: compte.id, extractionId, assetId: maison.id, facts, linker: new SourceUnitLinker([]), propagationOrigin: 'e2e-109k' });
    const versions = async () => (await sql<Json[]>`SELECT id::int AS id, status, payload, t3_pending FROM document_operation_candidates WHERE file_id = ${devis} ORDER BY id`);
    const journal = async () => (await sql<Json[]>`SELECT decision, candidate_key, state_fingerprint, categories, changes, t3_status FROM document_candidate_repair_propagations WHERE file_id = ${devis} ORDER BY id`);

    // 2. Réparation SANS incidence métier : faits écrits, aucune réévaluation, aucun signal T3.
    const r1 = await reparer([fait('Mention', 'Merci de votre confiance')]);
    expect(r1.inserted).toHaveLength(1);
    expect(r1.propagation?.decision).toBe('NO_BUSINESS_IMPACT');
    expect(await versions()).toHaveLength(1);

    // 3. Réparation « Total TTC 880,00 € » : supersession atomique et traçable, T3 signalé une fois.
    const r2 = await reparer([fait('Total TTC', '880,00 €', 2)]);
    expect(r2.propagation?.decision).toBe('SUPERSEDED');
    expect(r2.propagation?.categories).toContain('AMOUNT');
    expect(['REQUESTED', 'NOT_REQUESTED']).toContain(r2.propagation?.t3.status);
    const v = await versions();
    expect(v.map((x) => x.status)).toEqual(['SUPERSEDED', 'ACTIVE']);
    expect(v[1].t3_pending).toBe(true);
    expect(v[1].payload.financialHints).toEqual([expect.objectContaining({ role: 'FORECAST_COST', amountMinor: 88_000, currency: 'EUR' })]);
    expect(v[1].payload.repairPropagation).toMatchObject({ origin: 'e2e-109k', supersedes: v[0].id });
    // Preuve et provenance : l'indice financier est ancré sur le fait PERSISTÉ de la réparation ; l'existant est conservé.
    const [montantFait] = await sql<{ id: number }[]>`SELECT id::int AS id FROM document_facts WHERE file_id = ${devis} AND raw_value = '880,00 €' AND status = 'active'`;
    expect(v[1].payload.evidenceFactIds).toContain(montantFait.id);
    expect(v[1].payload.financialHints[0].evidence.factId).toBe(montantFait.id);
    expect(v[1].payload.businessReferences).toEqual(v[0].payload.businessReferences);
    expect((await journal()).map((j) => j.decision)).toEqual(['NO_BUSINESS_IMPACT', 'SUPERSEDED']);

    await k.passer(compte);
    const ops1 = await k.actives(compte);
    expect(ops1).toHaveLength(1);
    expect(ops1[0].id).toBe(ops0[0].id);
    expect((await k.composantes(ops1[0].id)).map((c) => [c.kind, c.amount_minor])).toEqual([['FORECAST_COST', 88_000]]);
    expect(await k.coutNet(ops1[0].id)).toBe(0);

    // 4. Rejouée à l'identique : aucun fait, aucune version, aucun signal (idempotence, convergence).
    const r3 = await reparer([fait('Total TTC', '880,00 €', 2)]);
    expect(r3.inserted).toEqual([]);
    const { propagateRepairToCandidates } = await import('@/services/ai/source-analysis/operation-candidates/repair-propagation.store');
    const tousFaits = (await sql<{ id: number }[]>`SELECT id::int AS id FROM document_facts WHERE file_id = ${devis} AND status = 'active' ORDER BY id`).map((x) => x.id);
    const rejeu = await propagateRepairToCandidates({ accountId: compte.id, fileId: devis, beforeFactIds: tousFaits.slice(0, 1), origin: 'e2e-109k-rejeu' });
    expect(rejeu.decision).toBe('UNCHANGED');
    expect(await versions()).toHaveLength(2);
    expect((await journal()).filter((j) => j.decision === 'SUPERSEDED')).toHaveLength(1);

    // 5. Facture du même devis : même événement, réalisé, 880 € comptés UNE fois (le prévu n'est pas additionné).
    await k.document(compte, maison.id, [cand({ ...commun, sourceRoleHint: 'INVOICE', statusHint: 'REALIZED', temporalHints: { realizedDate: '2026-11-02' },
      businessReferences: [ref('QUOTE', 'DV-2026-0042'), ref('INVOICE', 'FA-2026-0107')], financialHints: [fh('REALIZED_COST', 88_000, { economicDate: '2026-11-02' })] })],
    { type: 'INVOICE', title: 'Facture traitement charpente', amountCents: 88_000, date: '2026-11-02' });
    // 6. Rapport d'intervention (preuve de réalisation, sans montant).
    await k.document(compte, maison.id, [cand({ ...commun, sourceRoleHint: 'REPORT', statusHint: 'REALIZED', temporalHints: { realizedDate: '2026-11-02' },
      businessReferences: [ref('QUOTE', 'DV-2026-0042')] })], { type: 'INTERVENTION_REPORT', title: 'Rapport d’intervention', date: '2026-11-02' });
    await k.passer(compte);
    const ops2 = await k.actives(compte);
    expect(ops2).toHaveLength(1);
    expect(ops2[0].id).toBe(ops0[0].id);
    expect(ops2[0].status).toBe('REALIZED');
    const comps = await k.composantes(ops2[0].id);
    expect(comps.filter((c) => c.kind === 'REALIZED_COST').map((c) => c.amount_minor)).toEqual([88_000]);
    expect(await k.coutNet(ops2[0].id)).toBe(88_000);

    // 7. Réanalyse identique du devis puis nouveau passage T3 : aucun nouvel objet métier, aucun historique.
    const histo = await k.historique(compte);
    const nbComps = comps.length;
    await k.passer(compte);
    expect(await k.historique(compte)).toBe(histo);
    expect((await k.actives(compte))).toHaveLength(1);
    expect(await k.composantes(ops2[0].id)).toHaveLength(nbComps);
  });
});
