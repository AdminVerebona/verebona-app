/**
 * Lot 30 — « Référentiels : supprimer les sources de vérité concurrentes ».
 *
 * Un test par critère de la liste « Tests d'acceptation » du ticket
 * (REF-AC01 … REF-AC14). AC19 / AC20 (FIELD_CATALOG et vocabulaire T2) :
 * `services/canonical/registry/__tests__/t2-read-catalog.test.ts`.
 * Partie base de données (table `document_types`, BO) :
 * `src/test/e2e/scenarios/l30-referentiels.e2e.ts`.
 *
 * Ces tests sont faits pour ÉCHOUER si une évolution future recrée une
 * divergence (REF-AC14) : listes locales réintroduites, alias documentaire
 * traduit différemment, code V1 sans migration, etc.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn() }, db: {} }));

const {
  ASSET_FAMILIES, ACCEPTED_ASSET_CATEGORY_CODES, LEGACY_ASSET_FAMILIES, LEGACY_CATEGORY_ALIASES,
  assetDesignationsIn, assetFamilyStatus, assetVocabularyAlternatives, categoryOptionsWithCurrent,
  getAssetCategories, normalizeAssetCategory, toAssetFamilyCode, withoutAssetDesignations,
} = await import('@/lib/asset-taxonomy');
const { DOCUMENT_TYPES, RUBRICS, buildPromptReferential, getRubric, getTypesForRubric } = await import('@/lib/referential/v2');
const { DOCUMENT_TYPE_LIST, PICKER_DOCUMENT_TYPES } = await import('@/lib/document-type-constants');
const {
  DOCUMENT_TYPE_QUERY_WORDS, documentCodeLabel, documentCodesMatchingWord, isKnownStorageDocumentCode,
  resolveDocumentCode, resolveDocumentTypeCode,
} = await import('@/lib/referential/document-codes');
const { LEGACY_DOCUMENT_CODE_EQUIVALENTS, LEGACY_DOCUMENT_STORAGE_FALLBACKS } = await import('@/lib/referential/legacy-document-codes');
const { resolveLegacyType } = await import('@/lib/referential/v2/legacy-mapping');
const {
  DOCUMENT_CATALOG, EVENT_CATALOG, catalogForT2Read, getField, resolveDocumentType, toAssetFamily,
} = await import('@/services/canonical/registry');
const { AUTHORIZED_CREATION_TYPES } = await import('@/services/ai/agenda/agenda-intelligence.service');
const { documentEntryOf } = await import('@/services/ai/source-analysis/projection/rules');
const { catalogCodeOf } = await import('@/services/verebona-assistant/canonical/document-state');
const { extractSearchTerms, isInventoryQuery, tokenizeQuery } = await import('@/services/verebona-assistant/core/query-terms');
const { familleComparee } = await import('@/services/verebona-assistant/core/synthesis-planner');
const { entityHintsFor } = await import('@/services/verebona-assistant/core/intent-router.service');
const { resolveThreadReference } = await import('@/services/verebona-assistant/core/reference-resolver');
const { familyOf } = await import('@/services/verebona-assistant/commands/asset-fields');
const { toExportFamily } = await import('@/services/exports/catalog');
const { documentKind, documentTypeLabel } = await import('@/services/exports/v12/data/documents');
const { buildAssetTaxonomyReferentials, buildCodeMappings, buildCodeReferentials } = await import('@/app/api/admin/referentials/referentials-data');

const ROOT = resolve(__dirname, '../../../..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** Fichiers source (hors tests) sous un dossier. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(resolve(ROOT, dir))) {
    const p = join(dir, n);
    if (n === '__tests__' || n === 'node_modules') continue;
    if (statSync(resolve(ROOT, p)).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(n) && !/\.(test|e2e)\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** Les exemples du ticket, avec les variantes d'écriture d'un utilisateur. */
const EXEMPLES: Array<{ category: string; family: string; variantes: string[] }> = [
  { category: 'Maison', family: 'IMMOBILIER', variantes: ['maison', 'Maisons'] },
  { category: 'Appartement', family: 'IMMOBILIER', variantes: ['appartement', 'appartements'] },
  { category: 'Garage/box', family: 'IMMOBILIER', variantes: ['garage', 'box', 'garages', 'Garage/box'] },
  { category: 'Mobil-home', family: 'IMMOBILIER', variantes: ['mobil-home', 'mobil home', 'mobilhome', 'mobil-homes'] },
  { category: 'Local professionnel/commercial', family: 'IMMOBILIER', variantes: ['local professionnel', 'local commercial', 'locaux'.replace('locaux', 'local commercial')] },
  { category: 'Voiture', family: 'VEHICULE', variantes: ['voiture', 'voitures', 'auto'] },
  { category: 'Moto', family: 'VEHICULE', variantes: ['moto', 'motos'] },
  { category: 'Vélo', family: 'VEHICULE', variantes: ['vélo', 'velo', 'vélos'] },
  { category: 'Camping-car', family: 'VEHICULE', variantes: ['camping-car', 'camping car', 'campingcar', 'camping-cars'] },
  { category: 'Bateau', family: 'VEHICULE', variantes: ['bateau', 'bateaux'] },
  { category: 'Camion', family: 'VEHICULE', variantes: ['camion', 'camions'] },
];

describe('lot 30 — taxonomie des biens (§A, §B)', () => {
  it('REF-AC01 : Garage/box, Mobil-home, Camping-car… reconnus de façon identique par UI, T2 et recherche', () => {
    for (const ex of EXEMPLES) {
      // UI : la catégorie est proposée par le sélecteur de sa famille.
      expect(getAssetCategories(ex.family).map((c) => c.value), ex.category).toContain(ex.category);
      for (const v of ex.variantes) {
        // T2 : la variante désigne la catégorie (famille comprise).
        const [d] = assetDesignationsIn(`où est mon ${v} ?`);
        expect(d, v).toMatchObject({ kind: 'category', family: ex.family, category: ex.category });
        // UI : un ancien libellé stocké est normalisé vers la catégorie.
        if (LEGACY_CATEGORY_ALIASES[v.toLowerCase()]) expect(normalizeAssetCategory(v)).toBe(ex.category);
        // Recherche : mot de catégorie, jamais terme discriminant ; « mes X » est un inventaire.
        expect(extractSearchTerms(`mes ${v}`), v).toEqual([]);
        expect(isInventoryQuery(`quels sont mes ${v} ?`), v).toBe(true);
        // T2 : désignation d'un bien pour l'aiguillage et la comparaison.
        expect(entityHintsFor(`le ${v} de Lyon`).some((h) => h.type === 'asset'), v).toBe(true);
        expect(familleComparee(`compare mes deux ${v}`), v).toEqual([ex.family]);
        const ref = resolveThreadReference(`et ce ${v} ?`, {
          conversationId: 1, messages: [], presentedLists: [], lastPresentedEntities: [],
          lastSelected: null, currentAssetId: 42, currentDocumentId: null, pendingClarification: null,
        });
        expect(ref, v).toMatchObject({ kind: 'resolved', entity: { type: 'asset', id: 42 } });
      }
    }
    // Recherche documentaire : la désignation est retirée, le reste est cherché.
    expect(extractSearchTerms('facture du mobil-home de Biarritz')).toEqual(['facture', 'biarritz']);
    // Synonymes de recherche dérivés du référentiel.
    expect(tokenizeQuery('facture voiture').find((t) => t.stem === 'voiture')?.variants).toEqual(expect.arrayContaining(['vehicule', 'auto']));
    expect(tokenizeQuery('facture logement').find((t) => t.stem === 'logement')?.variants).toEqual(expect.arrayContaining(['immobilier', 'habitation']));
  });

  it('REF-AC02 : ajouter une catégorie dans asset-taxonomy suffit — aucun dictionnaire T2 à modifier', async () => {
    vi.resetModules();
    const tax = await import('@/lib/asset-taxonomy');
    const vehicule = tax.ASSET_FAMILIES.find((f) => f.code === 'VEHICULE')!;
    vehicule.categories.push({ value: 'Tracteur', label: 'Tracteur' });
    try {
      const qt = await import('@/services/verebona-assistant/core/query-terms');
      const sp = await import('@/services/verebona-assistant/core/synthesis-planner');
      const ir = await import('@/services/verebona-assistant/core/intent-router.service');
      expect(tax.assetDesignationsIn('mon tracteur')[0]).toMatchObject({ kind: 'category', family: 'VEHICULE', category: 'Tracteur' });
      expect(qt.isInventoryQuery('quels sont mes tracteurs ?')).toBe(true);
      expect(qt.extractSearchTerms('facture du tracteur')).toEqual(['facture']);
      expect(sp.familleComparee('compare mes deux tracteurs')).toEqual(['VEHICULE']);
      expect(ir.entityHintsFor('le tracteur').some((h) => h.type === 'asset')).toBe(true);
      expect(tax.categoryOptionsWithCurrent('VEHICULE', null).map((c) => c.value)).toContain('Tracteur');
    } finally {
      vehicule.categories.pop();
      vi.resetModules();
    }
  });

  it('REF-AC08 : familles historiques normalisées par un mécanisme unique (toAssetFamily)', () => {
    const codes = ['IMMOBILIER', 'VEHICULE', 'OBJECT', 'OBJET', 'MATERIEL_PRO', 'AUTRE', 'materiel_pro', ' Objet ', 'INCONNUE', '', null];
    for (const c of codes) {
      const f = toAssetFamilyCode(c);
      expect(toAssetFamily(c), String(c)).toBe(f);
      expect(toExportFamily(c), String(c)).toBe(f === 'OBJECT' ? 'OBJET' : f ?? null);
      if (c) expect(familyOf(c), c).toBe(f === 'IMMOBILIER' || f === 'VEHICULE' ? f : 'OBJET');
    }
    expect(toAssetFamilyCode('MATERIEL_PRO')).toBe('OBJECT');
    expect(toAssetFamilyCode('AUTRE')).toBe('OBJECT');
    expect(toAssetFamilyCode('OBJET')).toBe('OBJECT');
    expect(assetFamilyStatus('VEHICULE')).toBe('ACTIVE');
    expect(assetFamilyStatus('MATERIEL_PRO')).toBe('LEGACY_SUPPORTED');
    expect(assetFamilyStatus('XYZ')).toBe('UNKNOWN');
    // Aucune autre équivalence reconstruite dans le code (hors asset-taxonomy).
    const fautifs = sources('src').filter((p) => !p.endsWith('lib/asset-taxonomy.ts'))
      .filter((p) => /===\s*'MATERIEL_PRO'\s*\|\|[^\n]*'AUTRE'|'MATERIEL_PRO'\s*:\s*'OBJECT'|MATERIEL_PRO:\s*'OBJECT'/.test(lire(p)));
    expect(fautifs).toEqual([]);
  });
});

describe('lot 30 — types documentaires (§C à §G, §L)', () => {
  it('REF-AC03 : chaque type V2 appartient à une rubrique connue ; chaque code V1 est en base (migration)', () => {
    for (const t of DOCUMENT_TYPES) {
      expect(getRubric(t.rubric), t.code).toBeDefined();
      expect(resolveDocumentCode(t.code)).toMatchObject({ status: 'ACTIVE', origin: 'V2_TYPE', rubric: t.rubric });
    }
    expect(new Set(DOCUMENT_TYPES.map((t) => t.rubric))).toEqual(new Set(RUBRICS.map((r) => r.code)));
    // Table `document_types` : chaque code V1 du code est inséré par une migration.
    const dir = resolve(ROOT, 'src/db/migrations');
    const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(dir, f), 'utf8'))
      .filter((t) => /INSERT INTO document_types/i.test(t)).join('\n');
    const absents = DOCUMENT_TYPE_LIST.filter((t) => !sql.includes(`'${t.code}'`)).map((t) => t.code);
    expect(absents).toEqual([]);
  });

  it('REF-AC04 : chaque type sélectionnable est accepté par les API concernées', () => {
    // Sélecteur V1 (tiroir document, PUT /api/documents/:id, filtre GET /api/documents).
    expect(PICKER_DOCUMENT_TYPES.length).toBeGreaterThan(0);
    for (const t of PICKER_DOCUMENT_TYPES) {
      expect(isKnownStorageDocumentCode(t.code), t.code).toBe(true);
      expect(resolveDocumentTypeCode(t.code), t.code).toBe(t.code);
      expect(resolveDocumentCode(t.code).status, t.code).toBe('ACTIVE');
    }
    // Avant le lot 30, « Avis d'échéance » ou « Certificat » choisis devenaient « Autre » / « Diagnostic ».
    expect(resolveDocumentTypeCode('AVIS_ECHEANCE')).toBe('AVIS_ECHEANCE');
    expect(resolveDocumentTypeCode('CERTIFICAT')).toBe('CERTIFICAT');
    // Types V2 : acceptés par la route de classement (getDocumentType / rubrique).
    for (const t of DOCUMENT_TYPES) expect(resolveDocumentCode(t.code).v2Type).toBe(t.code);
    // Familles et catégories proposées : acceptées par l'API des biens.
    for (const f of ASSET_FAMILIES) expect(ACCEPTED_ASSET_CATEGORY_CODES).toContain(f.code);
    for (const [code, f] of Object.entries(LEGACY_ASSET_FAMILIES)) expect(ACCEPTED_ASSET_CATEGORY_CODES.includes(code)).toBe(f.stored);
    expect(lire('src/app/api/assets/route.ts')).toMatch(/VALID_CATEGORIES[^=]*= ACCEPTED_ASSET_CATEGORY_CODES/);
  });

  it('REF-AC05 : les types userOnly restent sélectionnables par l’utilisateur mais jamais proposés par l’IA', () => {
    const autres = DOCUMENT_TYPES.filter((t) => t.userOnly);
    expect(autres.length).toBe(RUBRICS.length);
    const projetes = new Set(buildPromptReferential().rubrics.flatMap((r) => r.types.map((t) => t.code)));
    for (const t of autres) {
      expect(getTypesForRubric(t.rubric).map((x) => x.code), t.code).toContain(t.code);
      expect(projetes.has(t.code), t.code).toBe(false);
      expect(resolveDocumentCode(t.code)).toMatchObject({ status: 'ACTIVE', aiSelectable: false });
    }
    for (const t of DOCUMENT_TYPES.filter((x) => !x.userOnly)) expect(resolveDocumentCode(t.code).aiSelectable, t.code).toBe(true);
  });

  it('REF-AC06 : un alias historique produit la même résolution dans T1, T2, T4, API et exports', () => {
    const tous = new Set<string>([
      ...DOCUMENT_TYPE_LIST.map((t) => t.code), ...DOCUMENT_TYPES.map((t) => t.code),
      ...Object.keys(LEGACY_DOCUMENT_CODE_EQUIVALENTS), ...Object.keys(LEGACY_DOCUMENT_STORAGE_FALLBACKS),
      ...DOCUMENT_CATALOG.flatMap((d) => [d.code, ...(d.aliases ?? [])]),
      'POLICE_ASSURANCE', 'DIAGNOSTIC_AMIANTE', 'CARNET_ENTRETIEN', 'BAIL', 'NOTICE',
    ]);
    for (const code of tous) {
      const r = resolveDocumentCode(code);
      const t4 = resolveDocumentType(code)?.code ?? null;                     // T4 (agenda), T3
      const t1 = documentEntryOf({ canonicalType: code })?.code ?? null;     // T1 (projection)
      const t2 = catalogCodeOf(code, null);                                   // T2 (lecture canonique)
      expect({ code, t1, t2, t4 }).toEqual({ code, t1: r.catalogCode, t2: r.catalogCode, t4: r.catalogCode });
      // API : la colonne `document_type` reçoit le code V1 de rangement du résolveur.
      expect(resolveDocumentTypeCode(code), code).toBe(r.storageCode ?? 'AUTRE');
      // Exports : libellé du code V1 de rangement (jamais une table locale).
      if (r.storageCode && r.storageCode !== 'AUTRE') {
        expect(documentTypeLabel({ id: 1, documentType: code }), code).toBe(DOCUMENT_TYPE_LIST.find((t) => t.code === r.storageCode)!.label);
      }
    }
    // Exemples : ancien code IA, ancien code DB, code V1, code V2.
    expect(resolveDocumentCode('FACTURE_ACHAT')).toMatchObject({ status: 'LEGACY_SUPPORTED', storageCode: 'FACTURE', catalogCode: 'FACTURE' });
    expect(resolveDocumentCode('peb')).toMatchObject({ storageCode: 'DPE', catalogCode: 'DPE', v2Type: 'DPE', rubric: 'COMPLIANCE_CONTROLS' });
    expect(resolveDocumentCode('POLICE_ASSURANCE')).toMatchObject({ v2Type: 'INSURANCE_POLICY', catalogCode: 'CONTRAT_ASSURANCE', authoritative: true });
    expect(documentKind({ id: 1, documentType: 'TITRE_PROPRIETE' })).toBe('ACTE_NOTARIE');
    expect(documentKind({ id: 1, documentType: 'TAXE_FONCIERE' })).toBe('FISCAL');
    expect(documentKind({ id: 1, documentType: 'PEB' })).toBe('DPE');
  });

  it('REF-AC07 : un code inconnu reste explicitement inconnu et n’est jamais autoritaire', () => {
    for (const code of ['XYZ_INCONNU', 'facture de gaz', '', null]) {
      const r = resolveDocumentCode(code);
      expect(r).toMatchObject({ status: 'UNKNOWN', origin: 'NONE', catalogCode: null, authoritative: false, v2Type: null, storageCode: null });
      expect(resolveDocumentType(code)).toBeUndefined();
      expect(resolveDocumentTypeCode(code)).toBe('AUTRE');
      expect(AUTHORIZED_CREATION_TYPES.has(String(code))).toBe(false);
    }
    // Un repli de STOCKAGE ne donne aucune règle métier : jamais autoritaire.
    for (const code of Object.keys(LEGACY_DOCUMENT_STORAGE_FALLBACKS)) {
      expect(resolveDocumentCode(code).authoritative, code).toBe(false);
      expect(AUTHORIZED_CREATION_TYPES.has(code), code).toBe(false);
    }
    expect(resolveDocumentCode('TAXE_FONCIERE')).toMatchObject({ storageCode: 'ACTE_TRANSACTION', catalogCode: null, v2Type: 'PROPERTY_TAX_NOTICE' });
    expect(documentCodeLabel('XYZ_INCONNU')).toBe('XYZ_INCONNU');
  });

  it('REF-AC11 : les routes API ne possèdent plus de listes métier concurrentes', () => {
    expect(lire('src/app/api/documents/route.ts')).not.toMatch(/VALID_DOCUMENT_TYPES\s*=/);
    expect(lire('src/types/domain.ts')).not.toMatch(/export const DOCUMENT_TYPES\b/);
    expect(lire('src/app/api/assets/route.ts')).not.toMatch(/\[\s*'IMMOBILIER',\s*'VEHICULE'/);
    expect(lire('src/app/api/assets/route.ts')).not.toMatch(/\[\s*'OBJECT_CATEGORY_TECH'/);
    // Aucune route ne déclare une liste littérale de codes documentaires.
    const fautives = sources('src/app/api').filter((p) => /\[\s*'FACTURE',\s*'(GARANTIE|DEVIS)'/.test(lire(p)));
    expect(fautives).toEqual([]);
  });

  it('REF-AC12 : les pickers ne possèdent plus leur propre taxonomie indépendante', () => {
    // Sélecteurs de biens : catégories issues de la taxonomie, valeur courante ancienne conservée.
    expect(categoryOptionsWithCurrent('IMMOBILIER', 'Garage').map((c) => c.value)).toEqual(getAssetCategories('IMMOBILIER').map((c) => c.value));
    expect(categoryOptionsWithCurrent('IMMOBILIER', 'Studio').map((c) => c.value)).toContain('Studio');
    // Sélecteurs de types : liste V1 sans formats ni codes CIL fins ; repli identique.
    expect(lire('src/components/document-edit-dialog.tsx')).not.toMatch(/DOCUMENT_TYPE_LIST/);
    expect(PICKER_DOCUMENT_TYPES.every((t) => !t.hideFromPicker)).toBe(true);
    // Aucun composant ne redéclare une liste de catégories ou de types.
    const fautifs = sources('src/components').concat(sources('src/app'))
      .filter((p) => /\[\s*'Maison',\s*'Appartement'|\[\s*'FACTURE',\s*'(GARANTIE|DEVIS)'|FACTURE:\s*'Facture',\s*\n?\s*GARANTIE:\s*'Garantie'/.test(lire(p)));
    expect(fautifs).toEqual([]);
    // Vocabulaire « type demandé » de l'assistant : chaque mot désigne un code du référentiel.
    for (const w of DOCUMENT_TYPE_QUERY_WORDS) expect(documentCodesMatchingWord(w).length, w).toBeGreaterThan(0);
  });
});

describe('lot 30 — registre, agenda, BO (§I à §K)', () => {
  it('REF-AC09 : toute clé T1/T2/T3/T4 est canonique, alias déclaré ou exclusion déclarée', () => {
    // T2 : le FIELD_CATALOG et le matcher ne connaissent que des clés canoniques.
    for (const f of catalogForT2Read().fields) expect(getField(f.key), f.key).toBeDefined();
    // T1, T3, T4, fiche, assistant : `registry-consistency.test.ts` (« clés employées aujourd'hui »).
    expect(lire('src/services/canonical/registry/__tests__/registry-consistency.test.ts')).toMatch(/clés employées aujourd’hui/);
    // T4 : chaque champ d'un événement est canonique.
    for (const e of EVENT_CATALOG) for (const k of e.fieldKeys) expect(getField(k), `${e.businessType}.${k}`).toBeDefined();
  });

  it('REF-AC10 : tout businessType documentaire existe dans EVENT_CATALOG ; AUTHORIZED_CREATION_TYPES dérivé', () => {
    const types = new Set(EVENT_CATALOG.map((e) => e.businessType));
    for (const d of DOCUMENT_CATALOG) {
      for (const b of d.businessTypes) expect(types.has(b), `${d.code}.${b}`).toBe(true);
      for (const p of d.completionProofs) for (const b of p.businessTypes ?? []) expect(types.has(b), `${d.code}.${p.code}`).toBe(true);
      for (const b of d.creationScope?.businessTypes ?? []) expect(d.businessTypes, d.code).toContain(b);
    }
    const attendus = new Set(DOCUMENT_CATALOG.filter((d) => d.mayCreateAgenda).flatMap((d) => [d.code, ...(d.aliases ?? [])]));
    expect([...AUTHORIZED_CREATION_TYPES].sort()).toEqual([...attendus].sort());
  });

  it('REF-AC13 : le BO affiche les valeurs des référentiels centraux', () => {
    const { assetFamilies, assetSubcategories } = buildAssetTaxonomyReferentials([], []);
    expect(assetFamilies.map((f) => f.code)).toEqual(ASSET_FAMILIES.map((f) => f.code));
    expect(assetSubcategories.map((c) => c.code)).toEqual(ASSET_FAMILIES.flatMap((f) => f.categories.map((c) => c.value)));
    const code = buildCodeReferentials(new Map(), new Map(), new Map([['FACTURE', 3]]));
    expect(code.rubrics.map((r) => r.code)).toEqual([...RUBRICS].sort((a, b) => a.displayOrder - b.displayOrder).map((r) => r.code));
    expect(code.documentTypes.map((t) => t.code)).toEqual([...DOCUMENT_TYPES.map((t) => t.code), ...DOCUMENT_TYPE_LIST.map((t) => t.code)]);
    expect(code.documentTypes.find((t) => t.code === 'ACQUISITION_INVOICE')?.details).toContain('règle métier : FACTURE');
    expect(code.documentTypes.find((t) => t.details?.startsWith('Type V1') && t.code === 'FACTURE')).toMatchObject({ usage: 3, active: true });
    // Mappings : ceux que le code applique réellement, traduits par le résolveur.
    const mappings = buildCodeMappings();
    for (const [c, f] of Object.entries(LEGACY_ASSET_FAMILIES)) expect(mappings.find((m) => m.code === c)?.label).toContain(f.family === 'OBJECT' ? 'Objet' : f.family);
    for (const [ancien, actuel] of Object.entries(LEGACY_CATEGORY_ALIASES)) expect(mappings.find((m) => m.code === ancien)?.label).toBe(`${ancien} → ${actuel}`);
    for (const c of Object.keys(LEGACY_DOCUMENT_CODE_EQUIVALENTS)) expect(mappings.find((m) => m.code === c)?.details).toContain(resolveDocumentCode(c).status);
  });

  it('REF-AC14 : relation DOCUMENT_TYPES ↔ DOCUMENT_CATALOG explicite ; toute divergence future échoue', () => {
    const v2 = new Set(DOCUMENT_TYPES.map((t) => t.code));
    const v1 = new Set(DOCUMENT_TYPE_LIST.map((t) => t.code));
    // Anciens codes de l'IA déclarés comme alias du catalogue, sans autre origine.
    const ANCIENS_CODES_IA = new Set(['PV_CONTROLE_TECHNIQUE', 'TICKET_CAISSE', 'SINISTRE']);
    for (const d of DOCUMENT_CATALOG) {
      for (const a of d.aliases ?? []) {
        const connu = v2.has(a) || v1.has(a) || a in LEGACY_DOCUMENT_CODE_EQUIVALENTS
          || resolveLegacyType({ typeCode: a, userSelected: false }).verdict === 'MAPPED' || ANCIENS_CODES_IA.has(a);
        expect(connu, `${d.code} : alias ${a} d’origine inconnue (ni V2, ni V1, ni ancien code déclaré)`).toBe(true);
      }
    }
    // Un code V1 et sa correspondance V2 certaine ont la même règle métier.
    for (const code of [...v1, ...Object.keys(LEGACY_DOCUMENT_CODE_EQUIVALENTS)]) {
      const r = resolveDocumentCode(code);
      if (r.v2Type && r.catalogCode) expect(resolveDocumentType(r.v2Type)?.code ?? r.catalogCode, code).toBe(r.catalogCode);
    }
    // Un équivalent ou repli pointe vers un code V1 existant.
    for (const cible of [...Object.values(LEGACY_DOCUMENT_CODE_EQUIVALENTS), ...Object.values(LEGACY_DOCUMENT_STORAGE_FALLBACKS)]) {
      expect(v1.has(cible), cible).toBe(true);
    }
    // Les familles d'un type V2 et de sa règle métier se recoupent.
    for (const t of DOCUMENT_TYPES) {
      const e = resolveDocumentType(t.code);
      if (!e || t.applicability === 'ALL') continue;
      const fams = new Set(t.applicability.map((f) => toAssetFamilyCode(f)));
      expect(e.families.some((f) => fams.has(f)), `${t.code} ↔ ${e.code}`).toBe(true);
    }
    // Plus aucun dictionnaire de biens propre à T2 (anciennes listes).
    for (const [p, nom] of [
      ['src/services/verebona-assistant/core/query-terms.ts', 'MOTS_CATEGORIE'],
      ['src/services/verebona-assistant/core/data-answer.service.ts', 'FAMILY_WORDS'],
      ['src/services/verebona-assistant/core/account-data.repository.ts', 'FAMILY_BY_WORD'],
      ['src/services/verebona-assistant/core/reference-resolver.ts', 'DEMONSTRATIF_BIEN'],
    ] as const) {
      expect(lire(p), `${p} : ${nom}`).not.toMatch(new RegExp(`const ${nom}\\b`));
    }
    expect(lire('src/services/verebona-assistant/core/query-terms.ts')).not.toMatch(/\['voiture', 'vehicule'/);
    // Le vocabulaire des biens couvre chaque famille et catégorie (rien d'oublié).
    const re = new RegExp(`^(?:${assetVocabularyAlternatives()})$`);
    for (const f of ASSET_FAMILIES) {
      expect(re.test(withoutAccents(f.label)), f.label).toBe(true);
      if (f.code !== 'OBJECT') for (const c of f.categories) expect(assetDesignationsIn(c.label)[0]?.category, c.label).toBe(c.value);
    }
    expect(withoutAssetDesignations('mes biens')).toBe('mes');
  });
});

function withoutAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
