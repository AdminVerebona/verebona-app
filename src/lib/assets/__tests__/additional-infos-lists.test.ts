/**
 * Informations complémentaires — listes structurées (schéma v2) : validation
 * (serveur et formulaire), relecture défensive, fusion, résolution des
 * conflits (409) et enregistrement automatique d'une liste.
 * CDC Exports V12 §4 (IC-GEN-005..009), §10 VENTE-PDF-05, §12 PDF-05/06,
 * §13 ASSURANCE_SINISTRE-PDF-04/06/08, RULE-001/002.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_SALE_HIGHLIGHTS, applyPatch, emptyAdditionalInfos, fieldsFor, findField, interpretListCellInput, listFormState,
  sanitizeSection, stripDraftRows, suggestionOrigin, validateAdditionalInfosPatch, validateListValue,
  type ListItem,
} from '../additional-infos';
import { createAutosaveQueue, patchListPaths, rebaseAfterConflict } from '../additional-infos-autosave';

const damages = findField('claim', 'damages')!;
const actions = findField('claim', 'actions')!;
const exchanges = findField('claim', 'exchanges')!;
const highlights = findField('commercial', 'highlights')!;
const charges = findField('finance', 'charges')!;

describe('dictionnaire : listes du design', () => {
  it('sinistre : dommages, actions, échanges, événement lié', () => {
    expect(damages.list!.columns.map((c) => c.key)).toEqual(['zone', 'element', 'finding', 'estimatedAmountCents', 'photoIds', 'documentIds']);
    expect(actions.list!.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['date', 'title', 'performedBy', 'invoiceDocumentId']));
    expect(exchanges.list!.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['date', 'direction', 'channel', 'summary', 'documentId']));
    expect(findField('claim', 'claimEventKey')?.type).toBe('eventRef');
  });

  it('points forts : 4 au plus (maquette), protections détaillées, éléments à assurer, charges', () => {
    expect(highlights.list!.maxItems).toBe(MAX_SALE_HIGHLIGHTS);
    expect(MAX_SALE_HIGHLIGHTS).toBe(4);
    expect(findField('insurance', 'protectionItems')?.type).toBe('list');
    expect(findField('insurance', 'insuredItems')?.type).toBe('list');
    expect(fieldsFor('finance').map((f) => f.key)).toEqual(['retainedValueCents', 'retainedValueSource', 'retainedValueDate', 'acquisitionFeesCents', 'charges']);
  });

  it('valeur retenue : aucune origine « estimation Verebona »', () => {
    const labels = findField('finance', 'retainedValueSource')!.options!.map((o) => o.label.toLowerCase());
    expect(labels.some((l) => l.includes('verebona') || l.includes('estimation'))).toBe(false);
  });
});

describe('validateListValue', () => {
  it('ligne valide normalisée : texte nettoyé, références dédoublonnées, identifiant conservé', () => {
    const r = validateListValue(damages, [{ id: 'd1', zone: '  Salle de bain ', finding: 'Auréoles\r\nplâtre', photoIds: [3, 3, 4], estimatedAmountCents: 0 }]);
    expect(r).toEqual({ ok: true, items: [{ id: 'd1', zone: 'Salle de bain', finding: 'Auréoles\nplâtre', photoIds: [3, 4], estimatedAmountCents: 0 }] });
  });

  it('champ requis manquant : chemin précis', () => {
    const r = validateListValue(damages, [{ id: 'd1', element: 'Plafond' }]);
    expect(r.ok).toBe(false);
    expect((r as { issues: unknown[] }).issues).toEqual([{ path: 'claim.damages[0].zone', message: 'Champ requis.' }]);
  });

  it('brouillons (lignes vides) ignorés, identifiant attribué s’il manque', () => {
    const r = validateListValue(damages, [{ id: 'vide' }, { zone: 'Couloir' }, { id: 'x', photoIds: [] }]);
    expect(r).toEqual({ ok: true, items: [{ zone: 'Couloir', id: 'r2' }] });
  });

  it('refus : colonne inconnue, identifiant invalide ou en double, trop de lignes, types', () => {
    const issues = (v: unknown, def = damages) => {
      const r = validateListValue(def, v);
      return r.ok ? [] : r.issues.map((i) => `${i.path} ${i.message}`);
    };
    expect(issues([{ zone: 'A', couleur: 'rouge' }])).toEqual(['claim.damages[0].couleur Colonne inconnue.']);
    expect(issues([{ id: 'a b', zone: 'A' }])).toEqual(['claim.damages[0].id Identifiant de ligne invalide.']);
    expect(issues([{ id: 'a', zone: 'A' }, { id: 'a', zone: 'B' }])).toEqual(['claim.damages[1].id Identifiant de ligne en double.']);
    expect(issues(Array.from({ length: 5 }, (_, i) => ({ title: `P${i}` })), highlights)).toEqual(['commercial.highlights 4 lignes au plus.']);
    expect(issues([{ zone: 'A', estimatedAmountCents: 12.5 }])[0]).toMatch(/estimatedAmountCents Le montant doit être exprimé en centimes/);
    expect(issues([{ zone: 'A', photoIds: [0] }])).toEqual(['claim.damages[0].photoIds Photo invalide.']);
    expect(issues([{ zone: 'A', photoIds: Array.from({ length: 13 }, (_, i) => i + 1) }])).toEqual(['claim.damages[0].photoIds 12 au plus.']);
    expect(issues({ zone: 'A' })).toEqual(['claim.damages Liste attendue.']);
    expect(issues([{ zone: 'x'.repeat(121) }])).toEqual(['claim.damages[0].zone 120 caractères au plus.']);
  });

  it('règles entre colonnes : période d’action, charge « Autre » à libeller', () => {
    const a = validateListValue(actions, [{ title: 'Séchage', date: '2026-08-22', endDate: '2026-08-08' }]);
    expect(a.ok ? [] : a.issues.map((i) => i.path)).toEqual(['claim.actions[0].endDate']);
    const c = validateListValue(charges, [{ kind: 'AUTRE', amountCents: 1000 }]);
    expect(c.ok ? [] : c.issues).toEqual([{ path: 'finance.charges[0].label', message: 'Précisez le libellé de cette charge.' }]);
    expect(validateListValue(charges, [{ kind: 'TAXE_FONCIERE', amountCents: 128500, period: 'AN', year: 2025 }]).ok).toBe(true);
  });

  it('échange : date et résumé requis, canal du dictionnaire', () => {
    const r = validateListValue(exchanges, [{ summary: 'Relance', channel: 'PIGEON' }]);
    expect(r.ok ? [] : r.issues.map((i) => i.path).sort()).toEqual(['claim.exchanges[0].channel', 'claim.exchanges[0].date']);
  });
});

describe('validateAdditionalInfosPatch avec listes', () => {
  it('liste + version : acceptée, chemins des listes et version rendus', () => {
    const r = validateAdditionalInfosPatch({ version: 3, claim: { damages: [{ id: 'd1', zone: 'SDB' }], claimType: 'DEGAT_DES_EAUX' } }, 'IMMOBILIER');
    expect(r).toMatchObject({ ok: true, listPaths: ['claim.damages'], expectedVersion: 3 });
    if (r.ok) expect(r.patch.set.claim).toEqual({ damages: [{ id: 'd1', zone: 'SDB' }], claimType: 'DEGAT_DES_EAUX' });
  });

  it('liste sans version : refusée (contrôle optimiste obligatoire)', () => {
    const r = validateAdditionalInfosPatch({ commercial: { highlights: [{ title: 'Garantie' }] } }, 'VEHICULE');
    expect(r).toEqual({ ok: false, issues: [{ path: 'version', message: expect.stringMatching(/Version requise/) }] });
  });

  it('champs simples sans version : acceptés (fusion champ par champ inchangée)', () => {
    expect(validateAdditionalInfosPatch({ claim: { claimType: 'VOL' } }, 'OBJET')).toMatchObject({ ok: true, listPaths: [], expectedVersion: null });
  });

  it('liste vide ou null : retirée ; brouillons seuls : retirée', () => {
    const r = validateAdditionalInfosPatch({ version: 1, claim: { damages: [], actions: null, exchanges: [{ id: 'x' }] } }, 'IMMOBILIER');
    expect(r.ok && r.patch.unset.claim).toEqual(['damages', 'actions', 'exchanges']);
  });

  it('version invalide, événement lié invalide', () => {
    expect(validateAdditionalInfosPatch({ version: -1, claim: { claimType: 'VOL' } }, 'OBJET')).toMatchObject({ ok: false, issues: [{ path: 'version' }] });
    expect(validateAdditionalInfosPatch({ claim: { claimEventKey: 'agenda:abc' } }, 'OBJET')).toMatchObject({ ok: false, issues: [{ path: 'claim.claimEventKey' }] });
    expect(validateAdditionalInfosPatch({ claim: { claimEventKey: 'agenda:34' } }, 'OBJET').ok).toBe(true);
  });

  it('sous-rubrique « Valeur et charges » : toutes familles', () => {
    for (const fam of ['IMMOBILIER', 'VEHICULE', 'OBJET'] as const) {
      expect(validateAdditionalInfosPatch({ finance: { retainedValueCents: 33500000, retainedValueSource: 'SAISIE' } }, fam).ok).toBe(true);
    }
  });
});

describe('relecture défensive et fusion', () => {
  it('sanitizeSection : lignes invalides écartées, les autres conservées, plafond respecté', () => {
    const out = sanitizeSection('commercial', {
      highlights: [{ id: 'a', title: 'OK' }, { id: 'b' }, { id: 'c', title: 42 }, 'x', ...Array.from({ length: 6 }, (_, i) => ({ id: `z${i}`, title: `T${i}` }))],
      salePitch: 'Accroche',
    });
    expect((out.highlights as ListItem[]).map((h) => h.id)).toEqual(['a', 'z0', 'z1', 'z2']);
    expect(out.salePitch).toBe('Accroche');
    expect(sanitizeSection('claim', { damages: 'texte' })).toEqual({});
  });

  it('applyPatch : une liste est remplacée en bloc (réordonnancement compris)', () => {
    const cur = { ...emptyAdditionalInfos(), claim: { damages: [{ id: 'a', zone: 'A' }, { id: 'b', zone: 'B' }] as ListItem[], claimType: 'VOL' } };
    const r = validateAdditionalInfosPatch({ version: 2, claim: { damages: [{ id: 'b', zone: 'B' }, { id: 'a', zone: 'A' }] } }, 'IMMOBILIER');
    if (!r.ok) throw new Error('patch');
    const next = applyPatch(cur, r.patch);
    expect((next.claim.damages as ListItem[]).map((d) => d.id)).toEqual(['b', 'a']);
    expect(next.claim.claimType).toBe('VOL');
    expect(next.finance).toEqual({});
  });
});

describe('formulaire : état d’une liste', () => {
  it('brouillons retirés avant envoi, erreurs rattachées à la ligne (par identifiant)', () => {
    const items: ListItem[] = [{ id: 'r1', zone: 'SDB' }, { id: 'r2' }, { id: 'r3', element: 'Plafond' }];
    expect(stripDraftRows(damages, items).map((i) => i.id)).toEqual(['r1', 'r3']);
    const st = listFormState(damages, items);
    expect(st.payload).toBeNull();
    expect(st.rowErrors).toEqual({ r3: { zone: 'Champ requis.' } });
    expect(listFormState(damages, items.slice(0, 2))).toEqual({ payload: [{ id: 'r1', zone: 'SDB' }], rowErrors: {}, listError: null });
  });

  it('cellules : euros → centimes, année, référence, texte conservé tel que saisi', () => {
    const money = damages.list!.columns.find((c) => c.key === 'estimatedAmountCents')!;
    expect(interpretListCellInput(money, '1 250,50')).toEqual({ kind: 'set', value: 125050 });
    expect(interpretListCellInput(money, '')).toEqual({ kind: 'clear' });
    expect(interpretListCellInput(money, '12,,5').kind).toBe('invalid');
    const year = charges.list!.columns.find((c) => c.key === 'year')!;
    expect(interpretListCellInput(year, '2025')).toEqual({ kind: 'set', value: 2025 });
    expect(interpretListCellInput(year, '25').kind).toBe('invalid');
    const zone = damages.list!.columns[0];
    expect(interpretListCellInput(zone, 'Salle ')).toEqual({ kind: 'set', value: 'Salle ' });
  });

  it('suggestion acceptée : origine tracée (masquée dans le formulaire)', () => {
    expect(suggestionOrigin('maintenance')).toBe('suggestion:maintenance');
    const r = validateListValue(highlights, [{ id: 'h', title: 'Entretien documenté', origin: suggestionOrigin('maintenance') }]);
    expect(r.ok).toBe(true);
  });
});

describe('conflits (409) : rebaseAfterConflict', () => {
  const base = { 'claim.damages': [{ id: 'a', zone: 'A' }] as ListItem[] };

  it('liste inchangée côté serveur (la version a bougé pour un autre champ) : rejouée', () => {
    const patch = { claim: { damages: [{ id: 'a', zone: 'A' }, { id: 'b', zone: 'B' }] as ListItem[], statusDetail: 'x' } };
    const current = { ...emptyAdditionalInfos(), claim: { damages: [{ id: 'a', zone: 'A' }] as ListItem[], circumstances: 'modifié ailleurs' } };
    expect(rebaseAfterConflict(patch, base, current)).toEqual({ retry: patch, conflicts: [] });
  });

  it('liste modifiée ailleurs : la version serveur l’emporte, les champs simples sont rejoués', () => {
    const patch = { claim: { damages: [{ id: 'b', zone: 'B' }] as ListItem[], statusDetail: 'x' } };
    const current = { ...emptyAdditionalInfos(), claim: { damages: [{ id: 'a', zone: 'A modifiée' }] as ListItem[] } };
    expect(rebaseAfterConflict(patch, base, current)).toEqual({ retry: { claim: { statusDetail: 'x' } }, conflicts: ['claim.damages'] });
  });

  it('liste vidée ailleurs, puis créée des deux côtés', () => {
    const current = { ...emptyAdditionalInfos() };
    expect(rebaseAfterConflict({ claim: { damages: null } }, base, current).conflicts).toEqual(['claim.damages']);
    expect(rebaseAfterConflict({ commercial: { highlights: [{ id: 'h', title: 'T' }] as ListItem[] } }, {}, current).conflicts).toEqual([]);
  });

  it('patchListPaths : seules les listes', () => {
    expect(patchListPaths({ claim: { damages: [], claimType: 'VOL' }, finance: { charges: null, retainedValueCents: 1 } })).toEqual(['claim.damages', 'finance.charges']);
  });
});

describe('enregistrement automatique d’une liste', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('dernière valeur de la liste envoyée en bloc, une seule fois, avec les champs simples', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const q = createAutosaveQueue({ save });
    q.set('claim', 'damages', [{ id: 'a', zone: 'A' }]);
    q.set('claim', 'claimType', 'VOL');
    q.set('claim', 'damages', [{ id: 'b', zone: 'B' }, { id: 'a', zone: 'A' }]);
    await vi.advanceTimersByTimeAsync(700);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual({ claim: { damages: [{ id: 'b', zone: 'B' }, { id: 'a', zone: 'A' }], claimType: 'VOL' } });
  });
});
