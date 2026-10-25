/**
 * Lot 86D — ticket P1 « Documents / Agenda — associations erronées et gestion
 * bidirectionnelle » : règles pures, registre, contrats statiques.
 *
 *   L86D-U-01  pertinence d'une association selon ses PREUVES (pur) : MANUAL_DIRECT jamais jugée ; OPERATION_PRINCIPAL
 *              fondée seulement par l'événement de référence d'un ensemble actif dont le document est membre ; AI_DIRECT
 *              fondée par une trace de production, l'origine de l'élément ou la règle de projection ; détachement
 *              de l'utilisateur ; sans preuve → constat (jamais une écriture) ; intercomptes → sécurité
 *   L86D-U-02  inspection du contrôle : verdict, anomalie, maillon, preuves tracées, empreinte stable (anti-boucle)
 *   L86D-U-03  registre : COH-DOC-AGENDA-LINKS actif, APRÈS les contrôles du lot 85 (position relative), couverture,
 *              réparations interdites (lien manuel, IA, lexical), service unique
 *   L86D-U-04  contrat d'affichage : geste « detacher-document », libellés sans « Opération » ni « principal »
 *   L86D-U-05  sources : garde d'écriture de la route de détachement, garde des provenances automatiques, lecture des
 *              associations par `agenda_file_links` seulement (cause racine : traces affichées comme liens)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateLinkRelevance, LINK_RELEVANCE_AI_CONTRACT, type LinkEvidenceSnapshot } from '../link-relevance';
import { DECISION_SUBJECTS } from '../model';

const lire = (p: string) => readFileSync(resolve(__dirname, '../../../../..', p), 'utf8').replace(/\r\n?/g, '\n');

const base: LinkEvidenceSnapshot = {
  linkId: 1, itemId: 10, fileId: 20, provenances: [], itemAccountId: 7, fileAccountId: 7, fileDeleted: false,
  itemProjected: false, operationId: null, role: null, fileMember: false, propagationRefused: false, userDetached: false,
  productionTraces: [], originRef: false,
};
const lien = (p: Partial<LinkEvidenceSnapshot>): LinkEvidenceSnapshot => ({ ...base, ...p });

describe('L86D-U-01 — pertinence d’une association selon ses preuves (pure)', () => {
  it('un lien posé par l’utilisateur (MANUAL_DIRECT) n’est jamais remis en cause, même cumulé à une provenance infondée', () => {
    for (const p of [['MANUAL_DIRECT'], ['MANUAL_DIRECT', 'OPERATION_PRINCIPAL'], ['AI_DIRECT', 'MANUAL_DIRECT']]) {
      const r = evaluateLinkRelevance(lien({ provenances: p }));
      expect(r).toMatchObject({ verdict: 'CONSISTENT', anomaly: null, unjustified: [], unproven: [] });
      expect(r.justified).toEqual([{ provenance: 'MANUAL_DIRECT', basis: 'USER_DECISION' }]);
    }
  });

  it('OPERATION_PRINCIPAL : fondée seulement sur l’événement de référence d’un ensemble actif dont le document est membre', () => {
    const ok = lien({ provenances: ['OPERATION_PRINCIPAL'], operationId: 3, role: 'PRINCIPAL', fileMember: true });
    expect(evaluateLinkRelevance(ok)).toMatchObject({ verdict: 'CONSISTENT', justified: [{ provenance: 'OPERATION_PRINCIPAL', basis: 'PRINCIPAL_OF_ENSEMBLE_WITH_MEMBER_DOCUMENT' }] });
    const cas: Array<[Partial<LinkEvidenceSnapshot>, string]> = [
      [{ operationId: null }, 'NO_ACTIVE_ENSEMBLE'],
      [{ role: 'RELATED' }, 'NOT_REFERENCE_EVENT'],
      [{ fileMember: false }, 'DOCUMENT_NOT_MEMBER'],
      [{ fileDeleted: true }, 'DOCUMENT_IN_TRASH'],
      [{ propagationRefused: true }, 'PROPAGATION_REFUSED'],
      [{ userDetached: true }, 'USER_DETACHED'],
    ];
    for (const [p, reason] of cas) {
      const r = evaluateLinkRelevance({ ...ok, ...p });
      expect(r).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'AUTOMATIC_LINK_UNJUSTIFIED', unjustified: [{ provenance: 'OPERATION_PRINCIPAL', reason }] });
    }
  });

  it('AI_DIRECT : trace de production propre au couple, origine de l’élément, règle de projection', () => {
    expect(evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT'], productionTraces: ['linked:SOURCE'] })).justified)
      .toEqual([{ provenance: 'AI_DIRECT', basis: 'PRODUCTION_TRACE' }]);
    expect(evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT'], originRef: true })).justified)
      .toEqual([{ provenance: 'AI_DIRECT', basis: 'ITEM_ORIGIN' }]);
    expect(evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT'], itemProjected: true, operationId: 3, role: 'RELATED', fileMember: true })))
      .toMatchObject({ verdict: 'CONSISTENT', justified: [{ provenance: 'AI_DIRECT', basis: 'PROJECTION_OF_ENSEMBLE_MEMBER' }] });
  });

  it('AI_DIRECT d’un élément projeté dont le document a quitté l’ensemble (copie de projection périmée) : démontrée infondée', () => {
    for (const p of [{ fileMember: false, operationId: 3 }, { operationId: null }, { fileMember: true, operationId: 3, fileDeleted: true }]) {
      expect(evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT'], itemProjected: true, role: 'RELATED', ...p })))
        .toMatchObject({ verdict: 'REPAIRABLE', unjustified: [{ provenance: 'AI_DIRECT', reason: 'PROJECTION_DOCUMENT_LEFT_ENSEMBLE' }] });
    }
  });

  it('AI_DIRECT sans aucune preuve propre (élément non projeté) : constat AMBIGUOUS, aucune provenance à retirer ; contrat IA nommé', () => {
    const r = evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT'] }));
    expect(r).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'AUTOMATIC_LINK_UNPROVEN', unjustified: [], unproven: ['AI_DIRECT'] });
    expect(LINK_RELEVANCE_AI_CONTRACT).toBe('86D-t4-pertinence-lien-document-agenda');
    // Même bien, date proche : ces informations ne font même pas partie des preuves lues (aucune règle lexicale ni chronologique).
    for (const k of ['assetId', 'title', 'date', 'startDate', 'documentDate']) expect(Object.keys(base)).not.toContain(k);
  });

  it('détachement de l’utilisateur : toute provenance automatique est infondée, même prouvée', () => {
    const r = evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT', 'OPERATION_PRINCIPAL'], userDetached: true, productionTraces: ['linked:SOURCE'], operationId: 3, role: 'PRINCIPAL', fileMember: true }));
    expect(r.verdict).toBe('REPAIRABLE');
    expect(r.unjustified.map((u) => [u.provenance, u.reason]).sort()).toEqual([['AI_DIRECT', 'USER_DETACHED'], ['OPERATION_PRINCIPAL', 'USER_DETACHED']]);
  });

  it('cumul : une provenance infondée est retirée, la provenance fondée reste (le lien demeure)', () => {
    const r = evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT', 'OPERATION_PRINCIPAL'], productionTraces: ['created:'], operationId: 3, role: 'RELATED' }));
    expect(r).toMatchObject({ verdict: 'REPAIRABLE', unjustified: [{ provenance: 'OPERATION_PRINCIPAL', reason: 'NOT_REFERENCE_EVENT' }], justified: [{ provenance: 'AI_DIRECT', basis: 'PRODUCTION_TRACE' }] });
  });

  it('lien entre deux comptes : FINDING sécurité, aucune provenance jugée ni retirée ici', () => {
    expect(evaluateLinkRelevance(lien({ provenances: ['AI_DIRECT'], fileAccountId: 8 }))).toMatchObject({ verdict: 'FINDING', anomaly: 'CROSS_ACCOUNT_LINK', unjustified: [] });
  });

  it('mémoire unifiée : objet AGENDA_FILE_LINK ajouté sans retirer les objets existants', () => {
    expect(DECISION_SUBJECTS).toEqual(['DOCUMENT', 'AGENDA', 'ROOM', 'EQUIPMENT', 'PRINCIPAL_LINK', 'PRINCIPAL', 'AGENDA_FILE_LINK']);
  });
});

describe('L86D-U-02 — inspection du contrôle COH-DOC-AGENDA-LINKS', async () => {
  const { inspectLink } = await import('@/services/coherence/registry/checks/document-agenda-links');
  it('verdicts, anomalies, maillon fautif, preuves tracées', () => {
    expect(inspectLink(lien({ provenances: ['AI_DIRECT'], originRef: true }))).toEqual({ verdict: 'CONSISTENT' });
    const rep = inspectLink(lien({ provenances: ['OPERATION_PRINCIPAL'], operationId: 3, role: 'RELATED' }));
    expect(rep).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'AUTOMATIC_LINK_UNJUSTIFIED', faultyLink: 'LINK', expected: { provenances: [] } });
    expect(rep.detail).toMatchObject({ itemId: 10, fileId: 20, unjustified: [{ provenance: 'OPERATION_PRINCIPAL', reason: 'NOT_REFERENCE_EVENT' }] });
    const amb = inspectLink(lien({ provenances: ['AI_DIRECT'] }));
    expect(amb).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'AUTOMATIC_LINK_UNPROVEN', detail: { aiContract: '86D-t4-pertinence-lien-document-agenda' } });
    expect(inspectLink(lien({ provenances: ['AI_DIRECT'], fileAccountId: 9 }))).toMatchObject({ verdict: 'FINDING', anomaly: 'CROSS_ACCOUNT_LINK' });
  });
  it('empreinte des entrées stable (anti-boucle) et sensible aux preuves', () => {
    const a = inspectLink(lien({ provenances: ['AI_DIRECT'] })).inputHash;
    expect(inspectLink(lien({ provenances: ['AI_DIRECT'] })).inputHash).toBe(a);
    expect(inspectLink(lien({ provenances: ['AI_DIRECT'], itemProjected: true, operationId: 2 })).inputHash).not.toBe(a);
  });
});

describe('L86D-U-03 — registre de cohérence', async () => {
  const { COHERENCE_REGISTRY, activeChecks, getCheck } = await import('@/services/coherence/registry');
  const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
  it('COH-DOC-AGENDA-LINKS actif, ajouté après les contrôles du lot 85 (position relative, sans réordonner)', () => {
    const ordre = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ordre.indexOf('COH-DOC-AGENDA-LINKS')).toBeGreaterThan(ordre.indexOf('COH-T1-KNOWLEDGE-CONSUMPTION'));
    expect(ordre.indexOf('COH-DOC-AGENDA-LINKS')).toBeGreaterThan(ordre.indexOf('COH-OPS-ACQUISITION-DATE'));
    expect(ordre.filter((id) => id === 'COH-DOC-AGENDA-LINKS')).toHaveLength(1);
    expect(activeChecks().map((c) => c.id)).toContain('COH-DOC-AGENDA-LINKS');
  });
  it('déclaration : objet = l’association, réparation par le service de regroupement, interdits explicites', () => {
    const c = getCheck('COH-DOC-AGENDA-LINKS')!;
    expect(c).toMatchObject({ objectType: 'agenda_file_link', level: 'N2', version: 1 });
    expect(typeof c.repair).toBe('function');
    expect(c.services).toContain('business-operations/grouping/service#withdrawAutomaticLinkProvenances');
    expect(c.anomalies).toEqual(['AUTOMATIC_LINK_UNJUSTIFIED', 'AUTOMATIC_LINK_UNPROVEN', 'CROSS_ACCOUNT_LINK']);
    const interdits = c.forbiddenRepairs.join(' | ');
    for (const t of ['MANUAL_DIRECT', 'sans preuve contraire', 'mots-clés', 'IA', 'service unique']) expect(interdits).toContain(t);
    for (const t of ['AGENDA_ITEM_UPDATED', 'BUSINESS_OPERATION_CHANGED', 'DOCUMENT_DELETED']) expect(c.triggers).toContain(t);
  });
  it('couverture : liens documentaires, agenda, rapprochements', () => {
    for (const d of ['documents-liens', 'agenda', 'rapprochements']) expect(COVERAGE_INVENTORY.find((e) => e.domain === d)!.checks).toContain('COH-DOC-AGENDA-LINKS');
  });
});

describe('L86D-U-04 — contrat d’affichage (geste, libellés)', async () => {
  const v = await import('@/lib/agenda/grouping-view');
  it('geste « detacher-document » reconnu ; les gestes 84B inchangés', () => {
    expect(v.isGroupingAction('detacher-document')).toBe(true);
    for (const a of ['relier-document', 'retirer-document', 'relier-element', 'retirer-reference']) expect(v.isGroupingAction(a)).toBe(true);
  });
  it('libellés : détacher n’est pas supprimer ; jamais « Opération » ni « principal »', () => {
    const L = v.GROUPING_LABELS;
    // Lot 89B : « Retirer l’association » (libellé PO du 25/10).
    expect(L.detachFromItem('Devis')).toBe('Retirer l’association avec « Devis »');
    expect(L.detachItemFromDocument('Visite')).toBe('Retirer l’association avec « Visite »');
    expect(L.removeFromEnsemble('Devis')).toBe('Retirer « Devis » de l’ensemble');
    expect(L.detachedToast).toContain('reste disponible');
    const textes = [L.linkedDocuments, L.detach, L.detachedToast, L.detachFromItem('x'), L.detachItemFromDocument('x'), L.removeFromEnsemble('x')].join(' ');
    expect(textes).not.toMatch(/opération|principal/i);
  });
});

describe('L86D-U-05 — sources (garde d’écriture, garde des provenances, lecture des associations)', () => {
  it('route DELETE /api/documents/:id/agenda-liens : garde d’écriture partagée avant tout geste ; geste du service unique', () => {
    const src = lire('src/app/api/documents/[id]/agenda-liens/route.ts');
    const del = src.slice(src.indexOf('export async function DELETE'));
    expect(del.indexOf('refuserSiLectureSeule')).toBeGreaterThan(0);
    expect(del.indexOf('refuserSiLectureSeule')).toBeLessThan(del.indexOf('applyAgendaDrawerAction'));
    expect(del).toContain("action: 'detacher-document'");
  });
  it('garde unique : aucune provenance automatique sur un lien détaché ; écrivains SQL bruts gardés', () => {
    const prov = lire('src/services/business-operations/grouping/provenance.ts');
    expect(prov).toContain("if (provenance !== 'MANUAL_DIRECT')");
    expect(prov).toContain('rejectedLinkFileIds');
    expect(lire('src/services/business-operations/agenda-projection/consolidation.ts')).toContain("linkRejectedSql('$1::int', 'asset_file_id')");
    expect(lire('src/services/agenda/backfill/agenda-backfill.ts')).toContain("dl.source_kind = 'AGENDA_FILE_LINK'");
  });
  it('associations lues par `agenda_file_links` seulement (traces et origine = historique, jamais un lien affiché)', () => {
    const q = lire('src/services/agenda/AgendaQueryService.ts');
    expect(q).not.toContain('agendaItemSources');
    const l = lire('src/services/agenda/agenda-source-links.ts');
    const fn = l.slice(l.indexOf('export async function listAgendaItemIdsForSource'), l.indexOf('/** Élément d\'agenda lié à un document'));
    expect(fn).toContain('agendaFileLinks');
    expect(fn).not.toMatch(/agendaItemSources|originRef/);
  });
  it('migration 0736 : objet AGENDA_FILE_LINK, Opération facultative pour lui seul, unicité active par lien', () => {
    const m = lire('src/db/migrations/0736_l86d_decision_lien_document_agenda.sql');
    expect(m).toContain("'AGENDA_FILE_LINK'");
    expect(m).toContain("(source_kind = 'AGENDA_FILE_LINK') = (candidate_operation_id IS NULL)");
    expect(m).not.toMatch(/CONCURRENTLY/);
    const idx = lire('src/db/migrations/0736_l86d_decision_lien_document_agenda_idx_1.sql');
    expect(idx).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS business_operation_match_decisions_link_active_uidx/);
  });
});
