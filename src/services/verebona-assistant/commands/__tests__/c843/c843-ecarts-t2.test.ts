/**
 * Carte #843 — Assistant T2, écarts restants après #807 : règles PURES (sans base). Les écritures, la concurrence,
 * la purge et l'isolation sont prouvées sur PostgreSQL réel (`src/test/e2e/scenarios/c843-*.e2e.ts`).
 *
 *   U01  E04  IBAN : détection en minuscules (clé de contrôle), masques du fil, du prompt et de la passerelle ;
 *   U02  E04  valeurs bancaires transitoires : scellement / descellement, données associées, proposition masquée ;
 *   U03  E08  sélection documentaire : filtres compris, inclus / exclus exacts, borne floue → question ;
 *   U04  E03  Agenda : retrait ciblé d'un lien, avant / après, série → limite dite ;
 *   U05       formulations libres : indices du modèle → formulations directes des nouveaux gestes ;
 *   U06  E05  texte de visibilité d'une opération déclarée ; E09 : paire « retirer puis rattacher » reconnue ;
 *   U07  E11  identité du prompt : source, empreinte, repli de lecture, dérive ;
 *   U08  E07  reconstruction après conflit des anciennes voies (nouvel aperçu, nouvelles versions).
 */
import { describe, expect, it } from 'vitest';
import { containsIban, ibanChecksumValid, maskIbansInText } from '@/lib/security/iban-mask';
import { maskSensitiveText } from '../../../core/sensitive-data.policy';
import { redact as redactGateway, redactWithReport } from '@/services/ai/gateway/redaction';
import { carriesClearIban, sealPlanActions, sealValue, unsealValue } from '../../plan-secrets';
import { natureOf, parseExportDocumentFilters, selectExportDocuments, vagueBoundQuestion, type ExportDocumentRow } from '../../export-selection';
import { parseExportRequest } from '../../export-request';
import { parseCommand } from '../../parser';
import { agendaDiff, AGENDA_SERIES_UPDATE_UNSUPPORTED } from '../../rich-edits';
import { draftsFromActionHints, exportSentenceFromHint } from '../../action-hints';
import { NOT_YET_VISIBLE } from '../../reference-events';
import { isDocumentTransferPair, DOCUMENT_TRANSFER_ATOMIC_EFFECT } from '../../reference-events-inverse';
import { WRITE_COMMAND_CATALOG, type PlannedAction } from '../../catalog';
import { promptDrift, promptIdentityFor, promptSourceOf, promptTextFingerprint } from '../../../core/prompt-instrumentation';
import { rebuildLegacyAfterConflict, REBUILT_AFTER_CONFLICT_EFFECT } from '../../conflict-rebuild';
import type { ActionHint } from '../../../types/contracts';

const TODAY = '2026-11-25';
const IBAN = 'FR7630006000011234567890189';
const ENV = { NODE_ENV: 'test', JWT_SECRET: 'c843-test' };

describe('C843-U01 — E04 : IBAN détecté et masqué partout, y compris en minuscules', () => {
  it('clé de contrôle ISO 13616 ; forme minuscule ou espacée reconnue ; texte ordinaire intact', () => {
    expect(ibanChecksumValid(IBAN)).toBe(true);
    expect(ibanChecksumValid('FR7630006000011234567890180')).toBe(false);
    expect(containsIban('change l’iban en fr76 3000 6000 0112 3456 7890 189 stp')).toBe(true);
    expect(containsIban('la référence ab12 cdef ghij klmn du devis')).toBe(false);
  });
  it('message du fil : forme masquée lisible, le reste du texte conservé', () => {
    const r = maskIbansInText('Change l’IBAN du fournisseur Durand en fr76 3000 6000 0112 3456 7890 189');
    expect(r.count).toBe(1);
    expect(r.text).toBe('Change l’IBAN du fournisseur Durand en FR76 •••• •••• 0189');
    expect(r.text).not.toMatch(/3000|1234/);
  });
  it('prompt du modèle et passerelle : plus aucun IBAN en minuscules ne passe', () => {
    const txt = 'Mon IBAN est fr76 3000 6000 0112 3456 7890 189.';
    expect(maskSensitiveText(txt).text).not.toMatch(/fr76|3000 6000/i);
    expect(maskSensitiveText(txt).report.counts.bank).toBe(1);
    expect(redactGateway(txt)).toContain('[IBAN_MASQUE]');
    expect(redactWithReport(txt).masks['[IBAN_MASQUE]']).toBe(1);
    // Forme historique en majuscules : inchangée.
    expect(redactGateway(`IBAN ${IBAN}`)).toBe('IBAN [IBAN_MASQUE]');
  });
});

describe('C843-U02 — E04 : valeur bancaire transitoire scellée hors de la proposition', () => {
  const action = (iban: string | null): PlannedAction => ({
    actionId: 'a1', command: 'UPDATE_SUPPLIER', dependsOn: [], targets: [{ type: 'supplier', id: 7, label: 'Durand' }], preview: 'p', effects: [],
    params: { kind: 'supplier_update', supplierId: 7, patch: { iban }, expectedVersion: 'v', banking: true },
  });
  it('chiffré lisible seulement pour CETTE proposition, CETTE action, CE champ', async () => {
    const ctx = { planId: 'p-1', actionId: 'a1', field: 'iban' };
    const s = await sealValue(IBAN, ctx, ENV);
    expect(s).toMatch(/^v1\.dev\./);
    expect(s).not.toContain(IBAN);
    expect(await unsealValue(s, ctx, ENV)).toBe(IBAN);
    expect(await unsealValue(s, { ...ctx, planId: 'p-2' }, ENV)).toBeNull();
    expect(await unsealValue(s, { ...ctx, actionId: 'a2' }, ENV)).toBeNull();
    expect(await unsealValue('v1.dev.xx.yy.zz', ctx, ENV)).toBeNull();
  });
  it('la proposition ne garde que la forme masquée ; une proposition sans IBAN est intacte', async () => {
    expect(carriesClearIban(action(IBAN))).toBe(true);
    expect(carriesClearIban(action(null))).toBe(false);
    const r = await sealPlanActions('p-1', [action(IBAN), action(null)]);
    expect(r.secrets).toHaveLength(1);
    expect(JSON.stringify(r.actions)).not.toContain(IBAN);
    expect((r.actions[0].params as { patch: { iban: string }; ibanSealed?: true }).patch.iban).toBe('FR76 •••• •••• 0189');
    expect((r.actions[0].params as { ibanSealed?: true }).ibanSealed).toBe(true);
    expect(carriesClearIban(r.actions[0])).toBe(false);
  });
});

const doc = (p: Partial<ExportDocumentRow> & { id: number; title: string }): ExportDocumentRow => ({
  date: null, typeCode: null, legacyType: null, equipmentId: null, equipmentName: null, rubricCodes: [], isWebLink: false, ...p,
});

describe('C843-U03 — E08 : sélection documentaire d’un export', () => {
  const docs = [
    doc({ id: 1, title: 'Facture chaudière', date: '2023-05-10', typeCode: 'WORKS_INVOICE', equipmentId: 9, equipmentName: 'Chaudière' }),
    doc({ id: 2, title: 'Facture toiture', date: '2024-03-02', typeCode: 'REPAIR_INVOICE' }),
    doc({ id: 3, title: 'Devis isolation', date: '2022-11-30', typeCode: 'WORKS_QUOTE' }),
    doc({ id: 4, title: 'Devis fenêtres', date: '2024-06-01', typeCode: 'WORKS_QUOTE' }),
    doc({ id: 5, title: 'Attestation assurance', date: '2024-01-15', typeCode: 'HOME_INSURANCE_CERTIFICATE' }),
    doc({ id: 6, title: 'Vieille facture', date: '2019-01-01', legacyType: 'FACTURE' }),
  ];
  it('« les factures de la maison sans les devis avant le 01/01/2024 » : filtres compris, bien reconnu, contenu exact', () => {
    const d = parseExportRequest('Exporte les factures de la maison sans les devis avant le 01/01/2024');
    expect(d?.assetWords).toEqual(['maison']);
    expect(d?.documents).toEqual({ include: ['invoice'], exclude: [{ nature: 'quote', bound: { before: '2024-01-01' } }] });
    const sel = selectExportDocuments(docs, d!.documents!);
    expect(sel.included.map((x) => x.id)).toEqual([1, 2, 6]);
    expect(Object.fromEntries(sel.excluded.map((x) => [x.doc.id, x.reason]))).toEqual({
      3: 'devis avant le 01/01/2024 : retiré à votre demande',
      4: 'non demandé (seuls les factures sont demandés)',
      5: 'non demandé (seuls les factures sont demandés)',
    });
  });
  it('« factures et devis, sans les devis avant le 01/01/2024 » : seuls les devis anciens sortent', () => {
    const f = parseExportDocumentFilters('les factures et les devis de la maison, sans les devis avant le 01/01/2024')!.filters;
    expect(selectExportDocuments(docs, f).included.map((x) => x.id)).toEqual([1, 2, 4, 6]);
  });
  it('borne floue (« anciens devis ») : question, jamais une date inventée', () => {
    const d = parseExportRequest('Exporte les données brutes de la maison sans les anciens devis');
    expect(d?.documents?.vague).toBe('anciens devis');
    expect(vagueBoundQuestion('anciens devis')).toMatch(/Donnez une date précise.*Rien n’a été lancé/);
  });
  it('période, équipement, document nommé ; nature lue sur le Type V2 ou l’ancien code', () => {
    const f = parseExportDocumentFilters('les factures de l\'equipement chaudiere en 2023')!.filters;
    expect(f.include).toEqual(['invoice']);
    expect(f.period).toEqual({ after: '2022-12-31', before: '2024-01-01' });
    expect(f.equipment).toEqual({ words: ['chaudiere'] });
    expect(selectExportDocuments(docs, f, { equipmentMatches: (x) => x.equipmentName === 'Chaudière' }).included.map((x) => x.id)).toEqual([1]);
    const g = parseExportDocumentFilters('sans le document « devis fenetres »', 'sans le document « Devis fenêtres »')!.filters;
    expect(selectExportDocuments(docs, g).excluded.map((x) => x.doc.id)).toEqual([4]);
    expect([natureOf(docs[0]), natureOf(docs[2]), natureOf(docs[4]), natureOf(docs[5])]).toEqual(['invoice', 'quote', null, 'invoice']);
  });
  it('sans filtre documentaire : comportement d’avant (aucune sélection)', () => {
    expect(parseExportRequest('Exporte les données brutes de la Clio')?.documents).toBeUndefined();
    expect(parseExportRequest('Exporte les données brutes de la Clio sans les photos')?.content).toEqual({ photos: false });
  });
});

describe('C843-U04 — E03 : Agenda, retrait ciblé d’un lien et portée', () => {
  it('« Retire le bien Polo de l’échéance Vidange » : un RETRAIT de lien, jamais la suppression de l’échéance', () => {
    const d = parseCommand('Retire le bien Polo de l’échéance Vidange', TODAY);
    expect(d).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', values: [{ key: 'removeAsset', raw: 'Polo' }], itemWords: ['vidange'] });
    expect(parseCommand('Détache le document Facture garage du rappel Entretien', TODAY)).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', values: [{ key: 'removeDocument', raw: 'Facture garage' }] });
    // Non-régression : supprimer l'échéance elle-même reste une suppression.
    expect(parseCommand('Supprime l’échéance Vidange', TODAY)).toMatchObject({ command: 'DELETE_AGENDA_ITEM' });
  });
  it('liste « libellé valeur » : « retirer le bien … » à côté d’un ajout', () => {
    expect(parseCommand('Modifie l’échéance Vidange : retirer le bien Polo, document Facture', TODAY)).toMatchObject({
      command: 'UPDATE_AGENDA_ITEM', values: [{ key: 'removeAsset', raw: 'Polo' }, { key: 'document', raw: 'Facture' }],
    });
  });
  it('avant / après : seul le lien nommé sort ; les autres restent', () => {
    const item = {
      title: 'Vidange', description: null, startDate: '2031-03-12', startTime: null, endDate: null, endTime: null, noDeadline: false, situation: null,
      assetLinks: [{ assetId: 1 }, { assetId: 2 }], roomLinks: [], equipmentLinks: [{ equipmentId: 5 }], fileLinks: [{ assetFileId: 8 }],
    } as never;
    const r = agendaDiff(item, { removeAssetIds: [2] }, { removedAssets: ['Polo'] });
    expect(r.input).toEqual({ assetIds: [1] });
    expect(r.lines).toEqual(['Bien retiré : Polo']);
    expect(agendaDiff(item, { removeAssetIds: [99] }).lines).toEqual([]);
  });
  it('série demandée : limite dite, jamais une occurrence modifiée en silence', () => {
    expect(parseCommand('Modifie toute la série des rappels vidange : description Carnet', TODAY)).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', seriesScope: true });
    expect(parseCommand('Reporte tous les rappels vidange au 20 mars 2031', TODAY)).toMatchObject({ seriesScope: true });
    expect(AGENDA_SERIES_UPDATE_UNSUPPORTED).toMatch(/ne permet pas de modifier toute une série.*Rien n’a été modifié/);
  });
});

const hint = (h: Partial<ActionHint> & Pick<ActionHint, 'operation' | 'entityType'>): ActionHint => ({ targetHint: null, fieldChanges: [], evidencePhrase: null, ...h });

describe('C843-U05 — formulations libres : nouveaux gestes compris par le sens, jamais une écriture ambiguë', () => {
  it('E01 : plusieurs champs de la fiche d’un équipement', () => {
    const r = draftsFromActionHints([hint({ operation: 'UPDATE', entityType: 'equipment', targetHint: 'la chaudière', fieldChanges: [
      { fieldHint: 'marque', value: 'Viessmann', unit: null }, { fieldHint: 'numéro de série', value: 'VS-1', unit: null }] })], TODAY);
    expect(r?.drafts[0]).toMatchObject({ command: 'UPDATE_EQUIPMENT', targetWords: ['chaudiere'], values: [{ key: 'brand', raw: 'Viessmann' }, { key: 'serialNumber', raw: 'VS-1' }] });
  });
  it('E03 : retirer un lien d’une échéance ; modifier sa description', () => {
    const r = draftsFromActionHints([hint({ operation: 'UNLINK', entityType: 'agenda_item', targetHint: 'vidange', fieldChanges: [{ fieldHint: 'bien', value: 'Polo', unit: null }] })], TODAY);
    expect(r?.drafts[0]).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', values: [{ key: 'removeAsset', raw: 'Polo' }] });
    const s = draftsFromActionHints([hint({ operation: 'UPDATE', entityType: 'agenda_item', targetHint: 'vidange', fieldChanges: [{ fieldHint: 'description', value: 'Apporter le carnet', unit: null }] })], TODAY);
    expect(s?.drafts[0]).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', values: [{ key: 'description', raw: 'Apporter le carnet' }] });
  });
  it('E04 : coordonnées d’un fournisseur ; JAMAIS les coordonnées bancaires par le sens', () => {
    const r = draftsFromActionHints([hint({ operation: 'UPDATE', entityType: 'supplier', targetHint: 'Plomberie Durand', fieldChanges: [
      { fieldHint: 'ville', value: 'Paris', unit: null }, { fieldHint: 'code postal', value: '75002', unit: null }] })], TODAY);
    expect(r?.drafts[0]).toMatchObject({ command: 'UPDATE_SUPPLIER' });
    expect(draftsFromActionHints([hint({ operation: 'UPDATE', entityType: 'supplier', targetHint: 'Durand', fieldChanges: [{ fieldHint: 'iban', value: '[coordonnées bancaires masquées]', unit: null }, { fieldHint: 'ville', value: 'Paris', unit: null }] })], TODAY)).toBeNull();
  });
  it('E09 : déplacer un document entre deux opérations (origine dite) — une demande de déplacement, puis deux gestes', () => {
    const r = draftsFromActionHints([hint({ operation: 'LINK', entityType: 'document', targetHint: 'Facture Norauto', fieldChanges: [
      { fieldHint: 'origine', value: 'intervention Vidange', unit: null }, { fieldHint: 'opération', value: 'intervention Freins', unit: null }] })], TODAY);
    expect(r?.drafts[0]).toMatchObject({ command: 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST' });
  });
  it('E08 : sélection d’export reprise dans la formulation directe', () => {
    const p = exportSentenceFromHint(hint({ operation: 'EXPORT', entityType: 'export', targetHint: 'la maison', fieldChanges: [{ fieldHint: 'documents', value: 'les factures sans les devis avant le 01/01/2024', unit: null }] }));
    expect(p).toBe('Exporte les données brutes de le bien maison avec les factures sans les devis avant le 01/01/2024');
    expect(parseExportRequest(p!)?.documents?.include).toEqual(['invoice']);
  });
  it('indice incomplet ou inconnu : écarté (la demande suit le parcours existant)', () => {
    expect(draftsFromActionHints([hint({ operation: 'UPDATE', entityType: 'equipment', targetHint: 'chaudière', fieldChanges: [{ fieldHint: 'couleur', value: 'rouge', unit: null }] })], TODAY)).toBeNull();
    expect(draftsFromActionHints([hint({ operation: 'UNLINK', entityType: 'agenda_item', targetHint: 'vidange', fieldChanges: [] })], TODAY)).toBeNull();
  });
});

describe('C843-U06 — E05 / E09 : textes et paire atomique', () => {
  it('E05 : une opération déclarée est dite visible (fiche, liste) — plus jamais « aucun écran »', () => {
    expect(NOT_YET_VISIBLE).toMatch(/sur sa fiche et dans la liste des opérations/);
    expect(NOT_YET_VISIBLE).not.toMatch(/aucun écran/);
  });
  it('E09 : « retirer de A » + « rattacher à B » du même document, dépendants → exécutés ensemble ; pas de commande « déplacer »', () => {
    const a = { actionId: 'a1', command: 'UNLINK_DOCUMENT_REFERENCE_EVENT', dependsOn: [], params: { kind: 'reference_event_document_unlink', operationId: 1, linkedDocumentId: 9, expectedVersion: 1, documentVersion: 'd' } } as unknown as PlannedAction;
    const b = { actionId: 'a1b', command: 'LINK_DOCUMENT_REFERENCE_EVENT', dependsOn: ['a1'], params: { kind: 'reference_event_document', operationId: 2, linkedDocumentId: 9, expectedVersion: 1, documentVersion: 'd' } } as unknown as PlannedAction;
    expect(isDocumentTransferPair(a, b)).toBe(true);
    expect(isDocumentTransferPair(a, { ...b, dependsOn: [] })).toBe(false);
    expect(isDocumentTransferPair(a, { ...b, params: { ...(b.params as object), linkedDocumentId: 10 } } as PlannedAction)).toBe(false);
    expect(DOCUMENT_TRANSFER_ATOMIC_EFFECT).toMatch(/le retrait est annulé et le document reste rattaché à la première/);
    expect(Object.keys(WRITE_COMMAND_CATALOG).filter((k) => /MOVE|TRANSFER|DEPLAC/.test(k))).toEqual([]);
  });
});

describe('C843-U07 — E11 : identité non sensible du prompt servi', () => {
  it('source lue sur la version ; empreinte non réversible', () => {
    expect(promptSourceOf('t2_master@pv12:abc')).toBe('BO_VERSION');
    expect(promptSourceOf('t2_master@cfg3:abc')).toBe('BO_CONFIG');
    expect(promptSourceOf('t2_master@file')).toBe('REPO_FILE');
    expect(promptSourceOf(null)).toBe('UNKNOWN');
    expect(promptTextFingerprint('texte du prompt')).toMatch(/^[0-9a-f]{16}$/);
  });
  it('résolution (BO active) ; échec de lecture → UNKNOWN avec code, jamais une identité inventée ; dérive signalée', async () => {
    const ok = await promptIdentityFor('t2_understand', { resolver: async () => ({ text: 'PROMPT', version: 't2@pv4:aa', execution: { source: 'version' } }) });
    expect(ok).toEqual({ operationCode: 't2_understand', version: 't2@pv4:aa', source: 'BO_VERSION', fingerprint: promptTextFingerprint('PROMPT') });
    const ko = await promptIdentityFor('t2_understand', { resolver: async () => { throw Object.assign(new Error('x'), { code: 'MASTER_PROMPT_INVALID' }); } });
    expect(ko).toMatchObject({ source: 'UNKNOWN', fingerprint: null, version: null, errorCode: 'MASTER_PROMPT_INVALID' });
    expect([promptDrift('a', 'a'), promptDrift('a', 'b'), promptDrift(null, 'b')]).toEqual([false, true, null]);
  });
});

describe('C843-U08 — E07 : après un conflit, les anciennes voies sont RELUES et reproposées', () => {
  const lookup = {
    getEquipmentState: async () => ({ id: 3, name: 'Chaudière B', assetId: 1, assetName: 'Maison', roomName: null, documents: 1, agenda: 0, version: 'v2' }),
    getRoomState: async () => null,
  } as never;
  const action = (name: string): PlannedAction => ({
    actionId: 'a1', command: 'RENAME_EQUIPMENT', dependsOn: [], targets: [{ type: 'equipment', id: 3, label: 'Chaudière' }],
    params: { kind: 'equipment_rename', equipmentId: 3, equipmentAssetId: 1, equipmentName: name, expectedVersion: 'v1' },
    preview: 'Renommer l’équipement « Chaudière » (Maison) en « Chaudière A ».', effects: [],
  });
  it('nouvel avant / après, nouvelle version attendue, mention de la relecture', async () => {
    const r = await rebuildLegacyAfterConflict(action('Chaudière A'), 1, lookup);
    expect(r?.preview).toBe('Renommer l’équipement « Chaudière B » (Maison) en « Chaudière A ».');
    expect((r?.params as { expectedVersion: string }).expectedVersion).toBe('v2');
    expect(r?.effects).toContain(REBUILT_AFTER_CONFLICT_EFFECT);
  });
  it('plus rien à changer, ou cible disparue : rien n’est reproposé', async () => {
    expect(await rebuildLegacyAfterConflict(action('Chaudière B'), 1, lookup)).toBeNull();
    const rename = { ...action('X'), command: 'RENAME_ROOM', params: { kind: 'room_rename', roomId: 4, roomAssetId: 1, roomName: 'X', expectedVersion: 'v' } } as PlannedAction;
    expect(await rebuildLegacyAfterConflict(rename, 1, lookup)).toBeNull();
  });
});
