/**
 * Lot 114O (Trello #744), travaux D — ÉCRITURE : gestes de la PAGE d'un
 * événement de référence (CDC « Opérations / Agenda V2.0 » §14, §19, §20 ;
 * AC41, AC44, AC45, AC47, AC48 pour leur partie « page » ; décisions du PO du
 * 15/11/2026).
 *
 *   L114OW-U01  textes : chaque code de la façade a une phrase utilisateur (jamais un code brut),
 *               jamais « Opération », décisions du PO n° 1 (annulation sans l'Agenda) et n° 2 (aucun motif)
 *   L114OW-U02  traduction d'un résultat de la façade : statut, phrase, code d'API
 *   L114OW-U03  lecture des demandes : identifiants, version attendue, correction, association
 *   L114OW-U04  formulaire « Corriger » : préremplissage, seul ce qui change est envoyé, refus dits avant l'envoi
 *   L114OW-U05  natures d'association proposées, alignées sur le graphe (qui fait foi)
 *   L114OW-U06  gardes de code : garde d'écriture dans chaque route, façade appelée, compte de la session,
 *               écran (ordinateur et mobile, charte, cibles tactiles, aucune règle métier, aucun code affiché)
 *   L114OW-U07  page rendue : les gestes proposés, un geste par ligne, rien proposé sans écriture
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REFERENCE_EVENT_ASSOCIATION_NATURES, REFERENCE_EVENT_ASSOCIATION_SOURCE_TYPE, REFERENCE_EVENT_CANDIDATE_KINDS,
  REFERENCE_EVENT_GESTURES, REFERENCE_EVENT_LABEL_MAX, REFERENCE_EVENT_MOVE_REMOVED, REFERENCE_EVENT_SUCCESS, REFERENCE_EVENT_WRITE_LABELS as L,
  REFERENCE_EVENT_WRITE_MESSAGES, buildReferenceEventCorrection, expectedVersionOf, isReferenceEventCandidateKind,
  parseReferenceEventAssociation, parseReferenceEventCorrection, positiveIdOf, referenceEventAssociationOptions,
  referenceEventCorrectionForm, referenceEventWriteOutcome,
  type ReferenceEventCorrectionCurrent, type ReferenceEventCorrectionForm,
} from '../reference-event-write';
import { OPERATION_RELATION_NATURES, RELATION_SOURCE_TYPE, applied, refused } from '@/services/business-operations/graph/model';
import type { ReferenceEventPageView } from '@/services/business-operations/graph/reference-event-page';
import { sansTextes806 } from './textes-806';

(globalThis as { React?: typeof React }).React = React;
const { ReferenceEventPageContent } = await import('@/components/reference-events/ReferenceEventPageContent');

const ROOT = process.cwd();
const lire = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
/** Code seulement (commentaires et imports retirés). */
const visible = (s: string) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '')).join('\n');

const ROUTES = [
  'src/app/api/evenements-reference/[id]/route.ts',
  'src/app/api/evenements-reference/[id]/associations/route.ts',
  'src/app/api/evenements-reference/[id]/documents/route.ts',
  'src/app/api/evenements-reference/[id]/evenements/route.ts',
  'src/app/api/evenements-reference/[id]/fournisseurs/route.ts',
  'src/app/api/evenements-reference/[id]/restauration/route.ts',
  // Règle complétée (carte #744, décision du PO du 16/11/2026 « Scinder : oui, maintenant ») : la scission.
  'src/app/api/evenements-reference/[id]/scission/route.ts',
  // Règle complétée (carte #744, travaux D « contenu ») : la note libre de l'utilisateur (migration 1722).
  'src/app/api/evenements-reference/[id]/notes/route.ts',
] as const;
const ECRANS = [
  'src/components/reference-events/ReferenceEventWrite.tsx',
  'src/components/reference-events/ReferenceEventPageContent.tsx',
  'src/app/(dashboard)/agenda/evenements-reference/[id]/page.tsx',
] as const;

describe('L114OW-U01 — textes de l’écran et des réponses', () => {
  it('chaque code de la façade porte une phrase utilisateur : jamais un code brut à l’écran', () => {
    for (const [code, phrase] of Object.entries(REFERENCE_EVENT_WRITE_MESSAGES)) {
      expect(phrase.length, code).toBeGreaterThan(10);
      // La phrase ne contient aucun code technique (MAJUSCULES_AVEC_SOULIGNÉS).
      expect(phrase, code).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}/);
      expect(phrase, code).toMatch(/[.…]$/);
    }
    for (const geste of REFERENCE_EVENT_GESTURES) expect(REFERENCE_EVENT_SUCCESS[geste], geste).toMatch(/[.…]$/);
  });

  it('aucun texte ne dit « événement de référence » ; « opération » partout', () => {
    const textes = [...Object.values(REFERENCE_EVENT_WRITE_MESSAGES), ...Object.values(REFERENCE_EVENT_SUCCESS), ...Object.values(L)];
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    for (const t of textes) expect(t, t).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(textes.filter((t) => /opération/i.test(t)).length).toBeGreaterThan(10);
  });

  it('décision du PO n° 1 : la confirmation AVANT dit ce qui est conservé et que l’Agenda détaché ne revient pas', () => {
    expect(L.deleteKept).toMatch(/conserv/i);
    expect(L.deleteUndo).toMatch(/annuler la suppression/i);
    // Dit honnêtement, avant de supprimer ET après : les événements détachés ne sont pas rattachés de nouveau.
    for (const t of [L.deleteUndo, L.deletedUndoHint, REFERENCE_EVENT_SUCCESS.restore]) expect(t, t).toMatch(/ne ser(ont|a) pas rattach|n’ont pas été rattachés/i);
    expect(L.undoDelete).toBe('Annuler la suppression');
  });

  it('décision du PO n° 2 : corriger l’intitulé ne demande ni déclaration, ni motif ; l’historique garde avant / après', () => {
    expect(L.correctHint).toMatch(/historique/i);
    expect(L.correctHint).toMatch(/Aucune justification/i);
    const tous = [...Object.values(L), ...Object.values(REFERENCE_EVENT_SUCCESS)].join(' ');
    expect(tous).not.toMatch(/motif|pourquoi cette correction|justifiez/i);
  });

  it('chaque retrait est confirmé et dit que seul le lien change', () => {
    for (const t of [L.unlinkAgendaBody, L.unlinkDocumentBody, L.unlinkSupplierBody, L.dissociateBody]) {
      expect(t, t).toMatch(/Seul le lien est retiré/);
      expect(t, t).toMatch(/pas (rattachés?|reliés?|associées?) de nouveau/);
    }
  });
});

describe('L114OW-U02 — traduction d’un résultat de la façade', () => {
  it('réussite : 200 et la phrase du geste ; rien n’a changé : 200 et le dit', () => {
    const ok = referenceEventWriteOutcome('correct', applied(true, {}));
    expect(ok).toMatchObject({ http: 200, ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.correct, apiCode: null });
    const rien = referenceEventWriteOutcome('linkDocument', applied(false, {}));
    expect(rien).toMatchObject({ http: 200, ok: true, changed: false, message: REFERENCE_EVENT_WRITE_MESSAGES.NO_CHANGE });
    expect(referenceEventWriteOutcome('delete', applied(true, {})).message).toBe(REFERENCE_EVENT_SUCCESS.delete);
    expect(referenceEventWriteOutcome('restore', applied(true, {})).message).toBe(REFERENCE_EVENT_SUCCESS.restore);
  });

  it('version périmée : 409 et un message clair (actualiser, recommencer) ; jamais le code', () => {
    const o = referenceEventWriteOutcome('correct', refused('CONFLICT', 'VERSION_MISMATCH', { currentVersion: 7 }));
    expect(o).toMatchObject({ http: 409, ok: false, changed: false, apiCode: 'INVALID_STATE' });
    expect(o.message).toBe(REFERENCE_EVENT_WRITE_MESSAGES.VERSION_MISMATCH);
    expect(o.message).toMatch(/modifiée entre-temps/);
    expect(o.message).not.toMatch(/VERSION_MISMATCH/);
  });

  it('droits, compte, état : 403, 404, 409 — chacun avec sa phrase', () => {
    expect(referenceEventWriteOutcome('correct', refused('FORBIDDEN', 'READ_ONLY_ACCOUNT'))).toMatchObject({ http: 403, apiCode: 'FORBIDDEN', message: REFERENCE_EVENT_WRITE_MESSAGES.READ_ONLY_ACCOUNT });
    expect(referenceEventWriteOutcome('correct', refused('FORBIDDEN', 'NOT_A_MEMBER')).http).toBe(403);
    expect(referenceEventWriteOutcome('linkAgenda', refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'))).toMatchObject({ http: 404, apiCode: 'NOT_FOUND' });
    expect(referenceEventWriteOutcome('correct', refused('FORBIDDEN', 'OPERATION_INACTIVE')).http).toBe(409);
    expect(referenceEventWriteOutcome('restore', refused('FORBIDDEN', 'NOT_RESTORABLE'))).toMatchObject({ http: 409, message: REFERENCE_EVENT_WRITE_MESSAGES.NOT_RESTORABLE });
    expect(referenceEventWriteOutcome('associate', refused('FORBIDDEN', 'REFLEXIVE')).http).toBe(422);
    expect(referenceEventWriteOutcome('associate', refused('FORBIDDEN', 'NATURE_TYPE_MISMATCH'))).toMatchObject({ http: 422, apiCode: 'INVALID_INPUT' });
  });

  it('panne : 500, rien n’a été modifié, et le dit', () => {
    const o = referenceEventWriteOutcome('unlinkDocument', { status: 'FAILED', code: 'TECHNICAL_FAILURE', changed: false });
    expect(o).toMatchObject({ http: 500, ok: false, changed: false, apiCode: 'INTERNAL_ERROR' });
    expect(o.message).toMatch(/Rien n’a été modifié/);
  });

  it('arbitrage requis (attributs, carte #744) : 409, aucune écriture annoncée', () => {
    const o = referenceEventWriteOutcome('correct', refused('ARBITRATION_REQUIRED', 'EVIDENCE_REQUIRED'));
    expect(o).toMatchObject({ http: 409, ok: false, changed: false });
  });
});

describe('L114OW-U03 — lecture des demandes (forme et bornes seulement)', () => {
  it('identifiant : entier positif, en nombre ou en texte', () => {
    expect(positiveIdOf(12)).toBe(12);
    expect(positiveIdOf('12')).toBe(12);
    for (const v of [0, -1, 1.5, '', '0', '-3', 'abc', '1'.repeat(16), null, undefined, {}, []]) expect(positiveIdOf(v), String(v)).toBeNull();
  });

  it('version attendue : absente, ou entier positif ; invalide : null', () => {
    expect(expectedVersionOf(undefined)).toBeUndefined();
    expect(expectedVersionOf('')).toBeUndefined();
    expect(expectedVersionOf(null)).toBeUndefined();
    expect(expectedVersionOf('3')).toBe(3);
    expect(expectedVersionOf('x')).toBeNull();
    expect(expectedVersionOf(0)).toBeNull();
  });

  it('correction : intitulé, type et dates par rôle ; on pose, on n’efface pas ; au moins un champ', () => {
    expect(parseReferenceEventCorrection({ label: '  Réfection  de la   toiture ' })).toEqual({ label: 'Réfection de la toiture' });
    expect(parseReferenceEventCorrection({ expectedVersion: 4, typeCode: 'INTERVENTION', dates: { realizedDate: '2025-06-27' } }))
      .toEqual({ expectedVersion: 4, typeCode: 'INTERVENTION', dates: { realizedDate: '2025-06-27' } });
    for (const b of [
      null, 'x', {}, { expectedVersion: 1 }, { label: '' }, { label: '   ' }, { label: 'x'.repeat(REFERENCE_EVENT_LABEL_MAX + 1) },
      { label: 42 }, { typeCode: 'intervention' }, { typeCode: '' }, { dates: { realizedDate: '27/06/2025' } },
      { dates: { realizedDate: null } }, { dates: { autreDate: '2025-06-27' } }, { dates: 'x' },
      { label: 'Toiture', status: 'DONE' }, { provider: 'Durand' }, { expectedVersion: 0, label: 'Toiture' },
    ]) expect(parseReferenceEventCorrection(b), JSON.stringify(b)).toBeNull();
    // L'intitulé le plus long admis passe.
    expect(parseReferenceEventCorrection({ label: 'x'.repeat(REFERENCE_EVENT_LABEL_MAX) })?.label).toHaveLength(REFERENCE_EVENT_LABEL_MAX);
  });

  it('association : « Associée à » par défaut, sans sens ; un lien orienté a un sens', () => {
    expect(parseReferenceEventAssociation({ otherId: 9 })).toEqual({ otherId: 9, nature: 'ASSOCIATED', direction: 'UNDIRECTED' });
    expect(parseReferenceEventAssociation({ otherId: '9', nature: 'FINANCING' })).toEqual({ otherId: 9, nature: 'FINANCING', direction: 'OUTGOING' });
    expect(parseReferenceEventAssociation({ otherId: 9, nature: 'CLAIM_REPAIR', direction: 'INCOMING' })).toEqual({ otherId: 9, nature: 'CLAIM_REPAIR', direction: 'INCOMING' });
    for (const b of [
      null, {}, { otherId: 0 }, { otherId: 9, nature: 'GROUPED' }, { otherId: 9, nature: 'ASSOCIATED', direction: 'OUTGOING' },
      { otherId: 9, nature: 'FINANCING', direction: 'UNDIRECTED' }, { otherId: 9, direction: 'AILLEURS' },
    ]) expect(parseReferenceEventAssociation(b), JSON.stringify(b)).toBeNull();
  });

  it('natures de candidats : celles de l’écran, rien d’autre', () => {
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la nature « move-target » (cible du déplacement d'un
    // document) est retirée avec le geste « Déplacer » ; elle est refusée comme toute nature inconnue.
    expect([...REFERENCE_EVENT_CANDIDATE_KINDS]).toEqual(['agenda', 'document', 'supplier', 'reference']);
    expect(isReferenceEventCandidateKind('move-target')).toBe(false);
    for (const k of REFERENCE_EVENT_CANDIDATE_KINDS) expect(isReferenceEventCandidateKind(k)).toBe(true);
    for (const k of ['', 'type', 'asset', 42, null]) expect(isReferenceEventCandidateKind(k), String(k)).toBe(false);
  });
});

describe('L114OW-U04 — formulaire « Corriger »', () => {
  const courant: ReferenceEventCorrectionCurrent = {
    version: 5, ownLabel: 'Toiture', typeCode: 'INTERVENTION',
    dates: [{ role: 'PLANNED', date: '2025-05-02' }, { role: 'REALIZED', date: '2025-06-20' }],
  };
  const forme = (over: Partial<ReferenceEventCorrectionForm> = {}): ReferenceEventCorrectionForm =>
    ({ ...referenceEventCorrectionForm(courant), ...over });

  it('prérempli avec ce que la page affiche ; aucune date inventée', () => {
    expect(referenceEventCorrectionForm(courant)).toEqual({
      label: 'Toiture', typeCode: 'INTERVENTION',
      dates: { PLANNED: '2025-05-02', START: '', REALIZED: '2025-06-20', END: '' },
    });
    expect(referenceEventCorrectionForm({ version: 1, ownLabel: null, typeCode: null, dates: [] }))
      .toEqual({ label: '', typeCode: '', dates: { PLANNED: '', START: '', REALIZED: '', END: '' } });
  });

  it('seul ce qui a changé est envoyé, avec la version lue par la page', () => {
    const r = buildReferenceEventCorrection(courant, forme({ label: 'Réfection de la toiture' }));
    expect(r).toEqual({ ok: true, body: { expectedVersion: 5, label: 'Réfection de la toiture' } });
    const d = buildReferenceEventCorrection(courant, forme({ dates: { PLANNED: '2025-05-02', START: '', REALIZED: '2025-06-27', END: '2025-07-01' } }));
    expect(d).toEqual({ ok: true, body: { expectedVersion: 5, dates: { realizedDate: '2025-06-27', endDate: '2025-07-01' } } });
    const t = buildReferenceEventCorrection(courant, forme({ typeCode: 'WORKS' }));
    expect(t).toEqual({ ok: true, body: { expectedVersion: 5, typeCode: 'WORKS' } });
  });

  it('refus dits à l’utilisateur AVANT tout envoi : effacement, intitulé trop long, aucune modification', () => {
    expect(buildReferenceEventCorrection(courant, forme({ label: '  ' }))).toEqual({ ok: false, error: L.labelEraseRefused });
    expect(buildReferenceEventCorrection(courant, forme({ label: 'x'.repeat(REFERENCE_EVENT_LABEL_MAX + 1) }))).toEqual({ ok: false, error: L.labelTooLong });
    expect(buildReferenceEventCorrection(courant, forme({ dates: { PLANNED: '', START: '', REALIZED: '2025-06-20', END: '' } })))
      .toEqual({ ok: false, error: L.dateEraseRefused });
    expect(buildReferenceEventCorrection(courant, forme())).toEqual({ ok: false, error: L.nothingToSave });
    // Un intitulé seulement reformaté (espaces) n'est pas une modification.
    expect(buildReferenceEventCorrection(courant, forme({ label: '  Toiture ' }))).toEqual({ ok: false, error: L.nothingToSave });
  });

  it('ce que le formulaire produit est accepté par la lecture de la demande côté serveur', () => {
    const r = buildReferenceEventCorrection(courant, forme({ label: 'Réfection', typeCode: 'WORKS', dates: { PLANNED: '2025-05-03', START: '', REALIZED: '2025-06-20', END: '' } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseReferenceEventCorrection(r.body)).toEqual(r.body);
  });

  it('une opération sans rien : le premier intitulé et les premières dates se posent', () => {
    const neuf: ReferenceEventCorrectionCurrent = { version: 2, ownLabel: null, typeCode: null, dates: [] };
    const r = buildReferenceEventCorrection(neuf, { label: 'Chaudière', typeCode: 'INTERVENTION', dates: { PLANNED: '2026-01-05', START: '', REALIZED: '', END: '' } });
    expect(r).toEqual({ ok: true, body: { expectedVersion: 2, label: 'Chaudière', typeCode: 'INTERVENTION', dates: { plannedDate: '2026-01-05' } } });
    // Tout laisser vide : rien à enregistrer, aucun envoi.
    expect(buildReferenceEventCorrection(neuf, { label: '', typeCode: '', dates: { PLANNED: '', START: '', REALIZED: '', END: '' } }))
      .toEqual({ ok: false, error: L.nothingToSave });
  });
});

describe('L114OW-U05 — natures d’association proposées', () => {
  it('l’écran est aligné sur le graphe, qui fait foi (aucune règle dupliquée)', () => {
    for (const nature of REFERENCE_EVENT_ASSOCIATION_NATURES) {
      expect((OPERATION_RELATION_NATURES as readonly string[]), nature).toContain(nature);
      expect(REFERENCE_EVENT_ASSOCIATION_SOURCE_TYPE[nature], nature).toBe(RELATION_SOURCE_TYPE[nature]);
    }
    // Les natures posables depuis la page sont exactement celles du graphe (aucune nature oubliée ni inventée).
    expect([...REFERENCE_EVENT_ASSOCIATION_NATURES].sort()).toEqual([...OPERATION_RELATION_NATURES].sort());
  });

  it('« Associée à » toujours proposé, sans sens ; un lien orienté seulement quand l’origine a le bon type', () => {
    expect(referenceEventAssociationOptions(null, null)).toEqual([{ nature: 'ASSOCIATED', direction: 'UNDIRECTED' }]);
    expect(referenceEventAssociationOptions('FINANCING', 'ACQUISITION')).toEqual([
      { nature: 'ASSOCIATED', direction: 'UNDIRECTED' }, { nature: 'FINANCING', direction: 'OUTGOING' },
    ]);
    expect(referenceEventAssociationOptions('ACQUISITION', 'FINANCING')).toEqual([
      { nature: 'ASSOCIATED', direction: 'UNDIRECTED' }, { nature: 'FINANCING', direction: 'INCOMING' },
    ]);
    expect(referenceEventAssociationOptions('CLAIM', 'INTERVENTION')).toEqual([
      { nature: 'ASSOCIATED', direction: 'UNDIRECTED' }, { nature: 'CLAIM_REPAIR', direction: 'OUTGOING' },
    ]);
    // Deux événements de référence du même type exigé : les deux sens sont proposés, l'utilisateur choisit.
    expect(referenceEventAssociationOptions('FINANCING', 'FINANCING')).toEqual([
      { nature: 'ASSOCIATED', direction: 'UNDIRECTED' }, { nature: 'FINANCING', direction: 'OUTGOING' }, { nature: 'FINANCING', direction: 'INCOMING' },
    ]);
  });
});

describe('L114OW-U06 — gardes de code', () => {
  it('chaque route d’écriture : garde de lecture seule, compte ACTIF de la session, façade appelée', () => {
    for (const p of ROUTES) {
      const code = visible(lire(p));
      const methodes = [...code.matchAll(/export async function (POST|PATCH|DELETE|PUT)\b/g)].map((m) => m[1]);
      expect(methodes.length, p).toBeGreaterThan(0);
      // Une garde par méthode d'écriture, dans le fichier de route (audit l85d-garde-ecriture-routes).
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : le PATCH de `documents` (déplacement) est retiré ;
      // il ne lit ni n'écrit rien et répond 410 — il n'a donc pas de garde d'écriture (vérifié à part ci-dessous).
      const ecritures = methodes.filter((m) => !(p.endsWith('/documents/route.ts') && m === 'PATCH'));
      expect(code.match(/refuserSiLectureSeule\(/g)?.length ?? 0, p).toBeGreaterThanOrEqual(ecritures.length);
      // La façade partagée fait l'écriture (chargée à la demande dans la route) : aucune écriture directe ici.
      expect(code, p).toContain("'@/services/business-operations/operation-write.facade'");
      expect(code, p).not.toMatch(/\b(?:INSERT INTO|UPDATE |DELETE FROM)\b/);
      // Le compte vient de la session (openReferenceEventRoute), jamais du corps de la requête.
      expect(code, p).toContain('openReferenceEventRoute(req, context)');
      expect(code, p).not.toMatch(/\baccountId:\s*(?:body|demande)\b/);
      // Chaque réponse d'écriture passe par la traduction en phrase utilisateur.
      expect(code, p).toContain('referenceEventWriteResponse(');
    }
  });

  it('règle remplacée (carte #806, décision du PO du 17/11/2026) : le déplacement d’un document n’a plus ni route utilisable, ni commande, ni texte', () => {
    const route = lire('src/app/api/evenements-reference/[id]/documents/route.ts');
    const patch = visible(route).slice(visible(route).indexOf('export async function PATCH'));
    // L'ancien client reçoit une erreur claire (410) qui dit de retirer puis de rattacher ; rien n'est lu ni écrit.
    expect(patch).toContain("return apiError(410, 'UNSUPPORTED', REFERENCE_EVENT_MOVE_REMOVED);");
    expect(patch).not.toMatch(/operation-write\.facade|readJsonBody|moveDocument/);
    expect(REFERENCE_EVENT_MOVE_REMOVED).toMatch(/Retirez le document de cette opération, puis rattachez-le à l’autre opération/);
    // La façade n'exporte plus la commande ; le corps interne ne sert que la scission.
    const facade = lire('src/services/business-operations/operation-write.facade.ts');
    expect(facade).not.toMatch(/export (async )?function moveDocument\b/);
    expect(facade).not.toMatch(/export interface MoveDocumentInput/);
    expect(facade.match(/moveDocumentBody\(ctx, g,/g)?.length).toBe(1);
    // Ni geste, ni libellé, ni nature de candidat, ni bouton.
    expect((REFERENCE_EVENT_GESTURES as readonly string[])).not.toContain('moveDocument');
    expect(Object.keys(L)).not.toEqual(expect.arrayContaining(['moveDocument']));
    expect(JSON.stringify({ ...L, ...REFERENCE_EVENT_SUCCESS })).not.toMatch(/Déplacer|déplacé\./);
    for (const p of ['src/components/reference-events/ReferenceEventPageContent.tsx', 'src/components/reference-events/ReferenceEventWrite.tsx']) {
      expect(visible(lire(p)), p).not.toMatch(/moveDocument|move-target|move-document|\/documents"\), \{ fileId, toId/);
    }
    expect(visible(lire('src/services/business-operations/graph/reference-event-candidates.ts'))).not.toMatch(/move-target/);
  });

  it('les treize gestes de la carte ont leur route, et chacun sa phrase de réussite', () => {
    const facade = lire('src/services/business-operations/operation-write.facade.ts');
    const commandes = ROUTES.map((p) => lire(p)).join('\n');
    const attendu: Record<string, string> = {
      correct: 'correctOperation', delete: 'invalidateOperation', restore: 'restoreOperation',
      linkAgenda: 'linkAgendaItem', unlinkAgenda: 'unlinkAgendaItem', linkDocument: 'linkDocument',
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : « moveDocument » retiré (retirer, puis rattacher).
      unlinkDocument: 'unlinkDocument', linkSupplier: 'linkSupplier',
      unlinkSupplier: 'unlinkSupplier', associate: 'associateOperations', dissociate: 'dissociateOperations',
      // Règle complétée (carte #744) : la scission, treizième geste (CDC §7, §14 ; AC46), puis la NOTE LIBRE,
      // quatorzième geste (travaux D « contenu », CDC §5 et §14, AC42) — une seule route et une seule commande,
      // deux phrases de réussite (note enregistrée / note retirée).
      split: 'splitOperation', notes: 'setOperationNotes', notesCleared: 'setOperationNotes',
    };
    expect(Object.keys(attendu).sort()).toEqual([...REFERENCE_EVENT_GESTURES].sort());
    for (const [geste, commande] of Object.entries(attendu)) {
      expect(facade, commande).toContain(`export function ${commande}(`);
      expect(commandes, commande).toContain(`${commande}(scope.ctx`);
      expect(REFERENCE_EVENT_SUCCESS[geste as keyof typeof REFERENCE_EVENT_SUCCESS], geste).toBeTruthy();
    }
  });

  it('écran : garde d’écriture avant chaque geste, phrase du serveur affichée, fiche relue sur conflit', () => {
    const code = visible(lire('src/components/reference-events/ReferenceEventWrite.tsx'));
    expect(code).toContain('useWriteGuard()');
    // Toute ouverture de fenêtre passe par la garde : un compte en lecture seule voit la fenêtre habituelle.
    expect(code).toMatch(/const ouvrir = \(f: Fenetre\) => garder\(/);
    expect(code).toContain('status === 409');
    // Les phrases viennent du serveur ou des textes partagés : aucune règle métier, aucun code à l'écran.
    expect(code).not.toMatch(/VERSION_MISMATCH|READ_ONLY_ACCOUNT|NOT_FOUND_IN_ACCOUNT/);
  });

  it('la page monte les fenêtres et transmet les gestes ; la suppression reste annulable sur place', () => {
    const page = visible(lire('src/app/(dashboard)/agenda/evenements-reference/[id]/page.tsx'));
    expect(page).toContain('useReferenceEventWrite(fiche, { onChanged, onDeleted })');
    expect(page).toContain('actions={actions}');
    expect(page).toContain('{dialogs}');
    expect(page).toContain('restoreReferenceEvent(supprime)');
    expect(page).toContain('data-testid="reference-event-undo-delete"');
    // Quitter ou recharger la page fait disparaître cette possibilité (aucune mémoire ailleurs).
    expect(page).toContain('setSupprime(null)');
    expect(page).not.toMatch(/localStorage|sessionStorage/);
  });

  it('écran : ordinateur et mobile, charte Sérénité (jetons seulement), cibles tactiles, jamais « événement de référence »', () => {
    for (const p of ECRANS) {
      const code = visible(lire(p));
      expect(code, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|zinc|neutral)-\d{2,3}\b/);
      expect(code, p).not.toMatch(/\buppercase\b/);
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
      expect(code, p).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
      expect(code, p).not.toMatch(/<Sheet\b|<Tabs\b|<Drawer\b/);
      expect(code, p).toMatch(/min-h-\[44px\]|h-11/);
    }
  });
});

describe('L114OW-U07 — page rendue avec ses gestes (même composant ordinateur et mobile)', () => {
  const fiche = (over: Partial<ReferenceEventPageView> = {}): ReferenceEventPageView => ({
    id: 42, redirectedFrom: null, version: 3, title: 'Intervention — Réfection de la toiture', ownLabel: 'Réfection de la toiture',
    typeCode: 'INTERVENTION', provider: 'Toitures Durand',
    dates: [{ role: 'REALIZED', date: '2025-06-27' }], undated: false,
    declarations: [], assets: [], equipments: [],
    suppliers: [{ id: 5, name: 'Toitures Durand' }],
    coverages: [],
    documents: [{ fileId: 11, title: 'Facture de toiture', date: '2025-06-27' }],
    agendaItems: [{ id: 21, title: 'Réfection de la toiture', date: '2025-06-27', shared: false }],
    relations: [{ operationId: 43, label: 'Financement — Prêt travaux', nature: 'FINANCING', direction: 'INCOMING' }],
    ...over,
  });
  const openers = { openDocument: () => undefined, openAgendaItem: () => undefined, openEquipment: () => undefined, onPeriodsSaved: () => undefined };
  const rien = () => undefined;
  const actions = {
    correct: rien, remove: rien, linkAgenda: rien, unlinkAgenda: rien, linkDocument: rien, unlinkDocument: rien,
    linkSupplier: rien, unlinkSupplier: rien, associate: rien, dissociate: rien,
  };
  const rendre = (avecGestes: boolean, f = fiche()) =>
    renderToStaticMarkup(h(ReferenceEventPageContent, { fiche: f, openers, ...(avecGestes ? { actions } : {}) }));

  it('les gestes de la page sont proposés une fois, par leur intitulé', () => {
    const html = rendre(true);
    expect(html).toContain('data-testid="reference-event-page-actions"');
    for (const [id, texte] of [
      ['correct', L.correct], ['link-agenda', L.linkAgenda], ['link-document', L.linkDocument],
      ['link-supplier', L.linkSupplier], ['associate', L.associate], ['delete', L.delete],
    ] as const) {
      expect(html, id).toContain(`data-testid="reference-event-action-${id}"`);
      expect(html, id).toContain(texte);
    }
    // Aucun mot interdit, aucun état, aucune fenêtre ouverte d'office.
    // Règle remplacée (carte #806) : « jamais "Opération" » — les textes NOUVEAUX de la carte #806 (liste fermée)
    // disent « opération » (décision du PO du 17/11/2026) ; les textes existants restent sous la garde d'origine.
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(sansTextes806(html)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|Statut|En cours|Terminé/i);
    expect(html).not.toMatch(/role="dialog"/);
  });

  // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la ligne d'un document ne propose plus « Déplacer ».
  it('chaque ligne porte le geste de son objet (détacher, retirer, dissocier) ; plus de « Déplacer »', () => {
    const html = rendre(true);
    expect(html).toContain('data-testid="reference-event-unlink-agenda-21"');
    expect(html).toContain('data-testid="reference-event-unlink-document-11"');
    expect(html).not.toContain('reference-event-move-document');
    expect(html).not.toMatch(/>Déplacer</);
    expect(html).toContain('data-testid="reference-event-unlink-supplier-5"');
    expect(html).toContain('data-testid="reference-event-dissociate-43"');
    // L'ouverture de l'objet reste le geste principal de la ligne.
    expect(html).toContain('data-reference-event-agenda-item="21"');
    expect(html).toContain('href="/agenda/evenements-reference/43"');
  });

  it('sans gestes (consultation) : la page est identique à la livraison en lecture, rien n’est proposé', () => {
    const html = rendre(false);
    expect(html).not.toContain('data-testid="reference-event-page-actions"');
    for (const t of [L.correct, L.delete, L.linkDocument, L.unlinkDocument, L.dissociate]) expect(html, t).not.toContain(t);
    // Le contenu lu reste là.
    expect(html).toContain('data-testid="reference-event-page-documents"');
    expect(html).toContain('Facture de toiture');
  });

  it('une opération vide garde ses gestes : « Compléter » ne dépend pas des rubriques affichées', () => {
    const nu = fiche({ suppliers: [], documents: [], agendaItems: [], relations: [], dates: [], undated: true, provider: null });
    const html = rendre(true, nu);
    expect(html).toContain('data-testid="reference-event-page-empty"');
    expect(html).toContain('data-testid="reference-event-action-link-document"');
    expect(html).toContain('data-testid="reference-event-action-correct"');
    expect(html).not.toContain('data-testid="reference-event-unlink-document-11"');
  });
});
