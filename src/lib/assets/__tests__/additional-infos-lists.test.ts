/**
 * Informations complémentaires — listes structurées (schéma v2) : validation
 * (serveur et formulaire), relecture défensive, fusion, résolution des
 * conflits (409) et enregistrement automatique d'une liste.
 * CDC Exports V12 §4 (IC-GEN-005..009), §10 VENTE-PDF-05, §12 PDF-05/06.
 *
 * Lot 83D (V-Q1, V-Q2) : la sous-rubrique « Sinistre » (dommages, actions,
 * échanges, événement lié) est retirée du dictionnaire. Le moteur GÉNÉRIQUE
 * des listes (références de pièces / photos, plafonds, requis) reste éprouvé
 * sur une liste de test de même forme, hors dictionnaire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_SALE_HIGHLIGHTS, applyPatch, emptyAdditionalInfos, fieldsFor, findField, interpretListCellInput, listFormState,
  sanitizeSection, stripDraftRows, suggestionOrigin, validateAdditionalInfosPatch, validateListValue,
  type AdditionalInfoFieldDef, type ListItem,
} from '../additional-infos';
import { createAutosaveQueue, patchListPaths, rebaseAfterConflict } from '../additional-infos-autosave';

/** Liste de TEST (hors dictionnaire), même forme que l'ancienne liste des dommages : éprouve le moteur générique. */
const damages: AdditionalInfoFieldDef = {
  section: 'insurance', key: 'items', type: 'list', label: 'Lignes de test',
  list: {
    maxItems: 30, itemLabel: 'Ligne', addLabel: 'Ajouter une ligne',
    columns: [
      { key: 'zone', type: 'text', label: 'Zone', required: true, max: 120 },
      { key: 'element', type: 'text', label: 'Élément', max: 200 },
      { key: 'finding', type: 'textarea', label: 'Constat', max: 600 },
      { key: 'estimatedAmountCents', type: 'money', label: 'Montant' },
      { key: 'photoIds', type: 'photoRefs', label: 'Photos liées', max: 12 },
      { key: 'documentIds', type: 'documentRefs', label: 'Pièces liées', max: 12 },
    ],
  },
};
const insuredItems = findField('insurance', 'insuredItems')!;
const highlights = findField('commercial', 'highlights')!;
const charges = findField('finance', 'charges')!;

describe('dictionnaire : listes du design', () => {
  it('lot 83D : plus de sous-rubrique « Sinistre » (ni dommages, ni actions, ni échanges, ni événement lié)', () => {
    for (const k of ['damages', 'actions', 'exchanges', 'claimEventKey', 'claimType']) expect(findField('claim' as never, k)).toBeUndefined();
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
    expect((r as { issues: unknown[] }).issues).toEqual([{ path: 'insurance.items[0].zone', message: 'Champ requis.' }]);
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
    expect(issues([{ zone: 'A', couleur: 'rouge' }])).toEqual(['insurance.items[0].couleur Colonne inconnue.']);
    expect(issues([{ id: 'a b', zone: 'A' }])).toEqual(['insurance.items[0].id Identifiant de ligne invalide.']);
    expect(issues([{ id: 'a', zone: 'A' }, { id: 'a', zone: 'B' }])).toEqual(['insurance.items[1].id Identifiant de ligne en double.']);
    expect(issues(Array.from({ length: 5 }, (_, i) => ({ title: `P${i}` })), highlights)).toEqual(['commercial.highlights 4 lignes au plus.']);
    expect(issues([{ zone: 'A', estimatedAmountCents: 12.5 }])[0]).toMatch(/estimatedAmountCents Le montant doit être exprimé en centimes/);
    expect(issues([{ zone: 'A', photoIds: [0] }])).toEqual(['insurance.items[0].photoIds Photo invalide.']);
    expect(issues([{ zone: 'A', photoIds: Array.from({ length: 13 }, (_, i) => i + 1) }])).toEqual(['insurance.items[0].photoIds 12 au plus.']);
    expect(issues({ zone: 'A' })).toEqual(['insurance.items Liste attendue.']);
    expect(issues([{ zone: 'x'.repeat(121) }])).toEqual(['insurance.items[0].zone 120 caractères au plus.']);
  });

  it('règles entre colonnes : charge « Autre » à libeller', () => {
    const c = validateListValue(charges, [{ kind: 'AUTRE', amountCents: 1000 }]);
    expect(c.ok ? [] : c.issues).toEqual([{ path: 'finance.charges[0].label', message: 'Précisez le libellé de cette charge.' }]);
    expect(validateListValue(charges, [{ kind: 'TAXE_FONCIERE', amountCents: 128500, period: 'AN', year: 2025 }]).ok).toBe(true);
  });

  it('éléments assurés : libellé requis', () => {
    const r = validateListValue(insuredItems, [{ valueCents: 1000, documentId: 4 }]);
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toEqual(['insurance.insuredItems[0].label']);
  });
});

describe('validateAdditionalInfosPatch avec listes', () => {
  it('liste + version : acceptée, chemins des listes et version rendus', () => {
    const r = validateAdditionalInfosPatch({ version: 3, insurance: { insuredItems: [{ id: 'd1', label: 'Housse' }], insuranceObjective: 'SOUSCRIRE' } }, 'IMMOBILIER');
    expect(r).toMatchObject({ ok: true, listPaths: ['insurance.insuredItems'], expectedVersion: 3 });
    if (r.ok) expect(r.patch.set.insurance).toEqual({ insuredItems: [{ id: 'd1', label: 'Housse' }], insuranceObjective: 'SOUSCRIRE' });
  });

  it('liste sans version : refusée (contrôle optimiste obligatoire)', () => {
    const r = validateAdditionalInfosPatch({ commercial: { highlights: [{ title: 'Garantie' }] } }, 'VEHICULE');
    expect(r).toEqual({ ok: false, issues: [{ path: 'version', message: expect.stringMatching(/Version requise/) }] });
  });

  it('champs simples sans version : acceptés (fusion champ par champ inchangée)', () => {
    expect(validateAdditionalInfosPatch({ insurance: { insuranceObjective: 'SOUSCRIRE' } }, 'OBJET')).toMatchObject({ ok: true, listPaths: [], expectedVersion: null });
  });

  it('liste vide ou null : retirée ; brouillons seuls : retirée', () => {
    const r = validateAdditionalInfosPatch({ version: 1, insurance: { insuredItems: [], protectionItems: [{ id: 'x' }] } }, 'IMMOBILIER');
    expect(r.ok && r.patch.unset.insurance).toEqual(['insuredItems', 'protectionItems']);
  });

  it('version invalide ; lot 83D : sous-rubrique « Sinistre » refusée', () => {
    expect(validateAdditionalInfosPatch({ version: -1, insurance: { insuranceObjective: 'SOUSCRIRE' } }, 'OBJET')).toMatchObject({ ok: false, issues: [{ path: 'version' }] });
    expect(validateAdditionalInfosPatch({ claim: { claimEventKey: 'agenda:34' } }, 'OBJET')).toMatchObject({ ok: false, issues: [{ path: 'claim' }] });
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
    expect(sanitizeSection('insurance', { insuredItems: 'texte' })).toEqual({});
  });

  it('applyPatch : une liste est remplacée en bloc (réordonnancement compris)', () => {
    const cur = { ...emptyAdditionalInfos(), insurance: { insuredItems: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] as ListItem[], insuranceObjective: 'SOUSCRIRE' } };
    const r = validateAdditionalInfosPatch({ version: 2, insurance: { insuredItems: [{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }] } }, 'IMMOBILIER');
    if (!r.ok) throw new Error('patch');
    const next = applyPatch(cur, r.patch);
    expect((next.insurance.insuredItems as ListItem[]).map((d) => d.id)).toEqual(['b', 'a']);
    expect(next.insurance.insuranceObjective).toBe('SOUSCRIRE');
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
  // Lot 83D : liste RÉELLE du dictionnaire (la résolution des conflits ne connaît que celles-ci).
  const base = { 'insurance.insuredItems': [{ id: 'a', zone: 'A' }] as ListItem[] };

  it('liste inchangée côté serveur (la version a bougé pour un autre champ) : rejouée', () => {
    const patch = { insurance: { insuredItems: [{ id: 'a', zone: 'A' }, { id: 'b', zone: 'B' }] as ListItem[], coverageComment: 'x' } };
    const current = { ...emptyAdditionalInfos(), insurance: { insuredItems: [{ id: 'a', zone: 'A' }] as ListItem[], specialItems: 'modifié ailleurs' } };
    expect(rebaseAfterConflict(patch, base, current)).toEqual({ retry: patch, conflicts: [] });
  });

  it('liste modifiée ailleurs : la version serveur l’emporte, les champs simples sont rejoués', () => {
    const patch = { insurance: { insuredItems: [{ id: 'b', zone: 'B' }] as ListItem[], coverageComment: 'x' } };
    const current = { ...emptyAdditionalInfos(), insurance: { insuredItems: [{ id: 'a', zone: 'A modifiée' }] as ListItem[] } };
    expect(rebaseAfterConflict(patch, base, current)).toEqual({ retry: { insurance: { coverageComment: 'x' } }, conflicts: ['insurance.insuredItems'] });
  });

  it('liste vidée ailleurs, puis créée des deux côtés', () => {
    const current = { ...emptyAdditionalInfos() };
    expect(rebaseAfterConflict({ insurance: { insuredItems: null } }, base, current).conflicts).toEqual(['insurance.insuredItems']);
    expect(rebaseAfterConflict({ commercial: { highlights: [{ id: 'h', title: 'T' }] as ListItem[] } }, {}, current).conflicts).toEqual([]);
  });

  it('patchListPaths : seules les listes', () => {
    expect(patchListPaths({ insurance: { insuredItems: [], insuranceObjective: 'SOUSCRIRE' }, finance: { charges: null, retainedValueCents: 1 } })).toEqual(['insurance.insuredItems', 'finance.charges']);
  });
});

describe('enregistrement automatique d’une liste', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('dernière valeur de la liste envoyée en bloc, une seule fois, avec les champs simples', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const q = createAutosaveQueue({ save });
    q.set('insurance', 'insuredItems', [{ id: 'a', label: 'A' }]);
    q.set('insurance', 'insuranceObjective', 'SOUSCRIRE');
    q.set('insurance', 'insuredItems', [{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }]);
    await vi.advanceTimersByTimeAsync(700);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual({ insurance: { insuredItems: [{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }], insuranceObjective: 'SOUSCRIRE' } });
  });
});
