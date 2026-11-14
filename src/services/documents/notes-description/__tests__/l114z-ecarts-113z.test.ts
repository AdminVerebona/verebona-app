/**
 * Lot 114Z (Trello #767) — Documents : les 5 écarts résiduels du lot 113Z (#723).
 *
 *   L114Z-U-SQL      E01  champ COURANT en SQL : même priorité que `resolveNotesDescription` ; schéma absent → `false` ;
 *   L114Z-U-T2       E01  les cinq chemins de recherche T2 lisent le champ courant (plus `description` et `notes` séparés) ;
 *   L114Z-U-SCHEMA   E02 / E05  état du schéma 1580 : READY / MISSING / UNKNOWN — « absent » et « illisible » distingués ;
 *   L114Z-U-STRICT   E02  lecture stricte pour un tiers : refus (jamais un repli), journal sans texte documentaire ;
 *   L114Z-U-INTENT   E05  intention utilisateur : écriture refusée si elle ne peut pas être persistée (règle 113Z remplacée) ;
 *   L114Z-U-VALID    E04  validation du texte libre : 0 / 1 / 5 000 / 5 001, Unicode, anciens champs, jamais de troncature ;
 *   L114Z-U-STATIC   E02 / E04 / E05  routes : plus de `.catch(() => new Map())`, plus de `.slice(0, NOTES_MAX_LENGTH)` ;
 *   L114Z-U-HEALTH   E05  alerte de disponibilité du schéma (BO › Exploitation › Santé).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reponse = unknown[] | Error;
const base = vi.hoisted(() => ({
  /** Réponse à la sonde `information_schema` (nombre de colonnes) ou erreur. */
  sonde: [{ n: 3 }] as Reponse,
  /** Réponse à la lecture des valeurs courantes, ou erreur. */
  lecture: [] as Reponse,
  requetes: [] as string[],
}));
vi.mock('@/db', () => ({
  db: {},
  pgClient: {
    unsafe: (texte: string) => {
      base.requetes.push(texte);
      const r = texte.includes('information_schema') ? base.sonde : base.lecture;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  },
}));

const lib = await import('@/lib/documents/notes-description');
const store = await import('../store');
const champ = await import('../current-field');
const sante = await import('../schema-health');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
/** Texte documentaire sensible : ne doit JAMAIS apparaître dans un journal. */
const SECRET = 'Ancienne description IA masquée — code portail 4471';

beforeEach(() => {
  base.sonde = [{ n: 3 }];
  base.lecture = [];
  base.requetes = [];
  store.resetNotesDescriptionSchemaCache();
  vi.restoreAllMocks();
});

describe('L114Z-U-SQL — E01 : champ courant en SQL (règle unique)', () => {
  it('colonnes présentes : reprise en main lue, note prioritaire, description en dernier', () => {
    const f = champ.currentFieldSqlFor('f', 'READY');
    expect(f.owned).toBe('coalesce(f.notes_user_owned, false)');
    // Ordre de la règle : reprise en main (même vide) → note non vide → description.
    expect(f.current).toMatch(/^\(CASE WHEN coalesce\(f\.notes_user_owned, false\) THEN coalesce\(btrim\(f\.notes, .*\), ''\) WHEN NULLIF\(btrim\(f\.notes, .*\), ''\) IS NOT NULL THEN btrim\(f\.notes, .*\) ELSE coalesce\(btrim\(f\.description, .*\), ''\) END\)$/);
    expect(f.descriptionIsCurrent).toBe(`(NOT ${f.fromNotes})`);
    expect(f.fromNotes).toContain('f.notes_user_owned');
  });
  it('schéma illisible (UNKNOWN) : la colonne est lue quand même — la requête échoue plutôt que de replier', () => {
    expect(champ.currentFieldSqlFor('af', 'UNKNOWN').owned).toBe('coalesce(af.notes_user_owned, false)');
  });
  it('colonnes absentes (MISSING, la base a répondu) : aucune reprise en main possible → false, la recherche reste disponible', () => {
    const f = champ.currentFieldSqlFor('f', 'MISSING');
    expect(f.owned).toBe('false');
    expect(f.current).not.toContain('notes_user_owned');
  });
  it('alias validé (aucune injection par l’alias)', () => {
    expect(() => champ.currentFieldSqlFor('f; DROP TABLE x', 'READY')).toThrow(/alias SQL invalide/);
    expect(champ.currentFieldSqlFor('"asset_files"', 'READY').owned).toBe('coalesce("asset_files".notes_user_owned, false)');
  });
  it('même décision que `resolveNotesDescription` sur les cas de la recette (source du texte courant)', () => {
    // Évaluation de la règle SQL, branche par branche, comparée à la fonction pure.
    const sqlBranche = (r: { notes: string | null; description: string | null; owned: boolean }) => {
      const note = r.notes?.trim() ? r.notes.trim() : null;
      if (r.owned) return { text: note ?? '', fromNotes: true };
      if (note !== null) return { text: note, fromNotes: true };
      return { text: r.description?.trim() ?? '', fromNotes: false };
    };
    const cas = [
      { notes: 'Note corrigée', description: 'Ancienne IA', owned: true },   // ancienne description IA + note corrigée
      { notes: null, description: 'Ancienne IA', owned: true },               // note explicitement vide
      { notes: null, description: 'Description T1', owned: false },           // note non modifiée
      { notes: null, description: 'Saisie historique', owned: false },        // description historique d'origine inconnue
      { notes: 'Ancienne note', description: 'IA', owned: false },            // note antérieure au lot, sans drapeau
      { notes: '   ', description: 'IA', owned: false },                      // note blanche = pas de note
      { notes: null, description: null, owned: false },
    ];
    for (const c of cas) {
      const v = lib.resolveNotesDescription({ notes: c.notes, description: c.description, notesUserOwned: c.owned });
      expect({ text: v.text, fromNotes: v.fromNotes }, JSON.stringify(c)).toEqual(sqlBranche(c));
    }
  });
});

describe('L114Z-U-T2 — E01 : tous les chemins de recherche T2 passent par le champ courant', () => {
  const CHEMINS = [
    'src/services/verebona-assistant/registries/retrieval-adapters.ts',
    'src/services/verebona-assistant/core/account-data.repository.ts',
    'src/services/verebona-assistant/core/synthesis-planner.ts',
    'src/services/ai/knowledge/document-knowledge.service.ts',
    'src/services/verebona-assistant/canonical/synthesis-content.ts',
  ];
  it('chaque chemin utilise `currentFieldSql`', () => {
    for (const f of CHEMINS) expect(lire(f), f).toMatch(/currentFieldSql\(/);
  });
  it('plus aucune recherche sur `description` et `notes` côte à côte', () => {
    expect(lire(CHEMINS[1])).not.toMatch(/coalesce\(f\.description,''\) \|\| ' ' \|\| coalesce\(f\.notes,''\)/);
    expect(lire(CHEMINS[2])).not.toMatch(/coalesce\(f\.description, ''\)\)\) LIKE/);
    const adaptateur = lire(CHEMINS[0]);
    expect(adaptateur).not.toMatch(/assetFiles\.description, assetFiles\.documentType, assetFiles\.documentTypeCode, assetFiles\.extractedText,\s*\/\/[^\n]*\n\s*assetFiles\.notes,/);
    // Contenu passé au modèle : la valeur courante résolue, jamais `l.description` brute à côté de la note.
    expect(adaptateur).toMatch(/resolveNotesDescription\(\{ notes: l\.notes, description: l\.description, notesUserOwned: l\.notesUserOwned === true \}\)/);
    expect(adaptateur).not.toMatch(/periodes\.get\(l\.id\), l\.description, note\]/);
  });
  it('description T1 de l’extraction : cherchée et rendue seulement si la description EST le champ courant', () => {
    for (const f of [CHEMINS[3], CHEMINS[4]]) expect(lire(f), f).toMatch(/CASE WHEN \$\{champ\.descriptionIsCurrent\} THEN e\.description ELSE NULL END/);
    // Le texte intégral (contenu réellement extrait du document) reste cherché : pas un nouveau moteur.
    expect(lire(CHEMINS[3])).toMatch(/coalesce\(e\.full_text,''\)/);
  });
  it('pas d’appel T1 ni d’index nouveau : le cache T2 est invalidé par l’événement métier existant', () => {
    const put = lire('src/app/api/documents/[id]/route.ts');
    expect(put).toMatch(/emitBusinessEvent\(\{ type: 'DOCUMENT_UPDATED'/);
    expect(put).toMatch(/\.filter\(\(k\) => k !== 'updatedAt' && k !== 'assetId' && k !== 'userEditedFields' && k !== 'titleSource' && k !== 'notes'\)/);
  });
});

describe('L114Z-U-SCHEMA — E02 / E05 : état du schéma 1580', () => {
  it('READY : les trois colonnes indispensables ; mémorisé', async () => {
    expect(await store.notesDescriptionSchemaState()).toBe('READY');
    expect(await store.notesDescriptionSchemaState()).toBe('READY');
    expect(base.requetes.filter((q) => q.includes('information_schema'))).toHaveLength(1);
    expect(await store.notesDescriptionColumnsReady()).toBe(true);
  });
  it('MISSING : la base a répondu, une colonne manque ; non mémorisé (relu au prochain appel)', async () => {
    base.sonde = [{ n: 2 }];
    expect(await store.notesDescriptionSchemaState()).toBe('MISSING');
    base.sonde = [{ n: 3 }];
    expect(await store.notesDescriptionSchemaState()).toBe('READY');
  });
  it('UNKNOWN : erreur SQL / délai — distinct de MISSING, jamais « prêt »', async () => {
    base.sonde = new Error('canceling statement due to statement timeout');
    expect(await store.notesDescriptionSchemaState()).toBe('UNKNOWN');
    expect(await store.notesDescriptionColumnsReady()).toBe(false);
  });
});

describe('L114Z-U-STRICT — E02 : lecture stricte pour une sortie vers un tiers (fail-closed)', () => {
  const erreurs = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  it('fonctionnement normal : valeurs courantes lues ensemble, bornées au compte', async () => {
    base.lecture = [
      { id: 1, notes: 'Note', description: SECRET, notes_user_owned: true, description_source: 'T1' },
      { id: 2, notes: null, description: 'Description T1', notes_user_owned: false, description_source: 'T1' },
    ];
    const m = await store.readCurrentNotesDescriptionManyStrict(7, [1, 2, 2], 'test');
    expect(m.get(1)).toEqual({ notes: 'Note', description: SECRET, notesUserOwned: true, descriptionSource: 'T1' });
    expect(m.get(2)).toEqual({ notes: null, description: 'Description T1', notesUserOwned: false, descriptionSource: 'T1' });
    expect(base.requetes.at(-1)).toMatch(/WHERE account_id = \$1 AND id = ANY\(\$2::int\[\]\)/);
  });
  it('colonnes absentes → refus SCHEMA_MISSING (aucune lecture de repli)', async () => {
    const log = erreurs();
    base.sonde = [{ n: 0 }];
    await expect(store.readCurrentNotesDescriptionManyStrict(7, [1], 'transmission 9')).rejects.toMatchObject({ code: 'NOTES_DESCRIPTION_UNAVAILABLE', reason: 'SCHEMA_MISSING' });
    expect(base.requetes.some((q) => q.includes('FROM asset_files'))).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toMatch(/transmission 9 : inclusion refusée — schéma 1580 incomplet/);
  });
  it('schéma illisible → refus SCHEMA_UNKNOWN', async () => {
    erreurs();
    base.sonde = new Error('timeout');
    await expect(store.readCurrentNotesDescriptionManyStrict(7, [1], 'x')).rejects.toMatchObject({ reason: 'SCHEMA_UNKNOWN' });
  });
  it('exception SQL / délai à la lecture → refus READ_FAILED ; le journal ne contient ni le message SQL ni un texte documentaire', async () => {
    const log = erreurs();
    base.lecture = Object.assign(new Error(`statement timeout near "${SECRET}"`), { code: '57014' });
    await expect(store.readCurrentNotesDescriptionManyStrict(7, [1, 2], 'transmission 9')).rejects.toMatchObject({ reason: 'READ_FAILED' });
    const trace = log.mock.calls.flat().join(' ');
    expect(trace).toMatch(/compte 7, 2 document\(s\), code 57014/);
    expect(trace).not.toContain(SECRET);
    expect(trace).not.toContain('portail');
  });
  it('métadonnées absentes pour un document (absent du compte) : pas d’entrée → aucun texte, jamais un repli', async () => {
    const avert = vi.spyOn(console, 'warn').mockImplementation(() => {});
    base.lecture = [{ id: 1, notes: 'Note', description: null, notes_user_owned: true, description_source: null }];
    const m = await store.readCurrentNotesDescriptionManyStrict(7, [1, 99], 'x');
    expect([...m.keys()]).toEqual([1]);
    expect(avert.mock.calls.flat().join(' ')).toMatch(/1 document\(s\) sans métadonnées/);
    // L'appelant (transmission, dossier) n'inclut rien pour le document 99.
    const tiers = await import('../third-party');
    expect(tiers.notesDescriptionForThirdParty(m.get(99) ?? {}, !!m.get(99))).toEqual({ notes: null, description: null, notesUserOwned: false, descriptionSource: null });
  });
  it('texte effectif seul : effacement explicite → rien ; note prioritaire → jamais la description en parallèle', async () => {
    const tiers = await import('../third-party');
    expect(tiers.notesDescriptionForThirdParty({ notes: null, description: SECRET, notesUserOwned: true, descriptionSource: 'T1' }, true))
      .toEqual({ notes: null, description: null, notesUserOwned: false, descriptionSource: null });
    expect(tiers.notesDescriptionForThirdParty({ notes: 'Note corrigée', description: SECRET, notesUserOwned: true, descriptionSource: 'T1' }, true))
      .toEqual({ notes: 'Note corrigée', description: null, notesUserOwned: true, descriptionSource: null });
    // Option non cochée, omise ou falsifiée : rien.
    for (const v of [false, undefined, null, 'true' as unknown as boolean, 1 as unknown as boolean]) {
      expect(tiers.notesDescriptionForThirdParty({ notes: 'Note', description: SECRET }, v)).toMatchObject({ notes: null, description: null });
    }
  });
});

describe('L114Z-U-INTENT — E05 : intention utilisateur non persistable → écriture refusée', () => {
  const exec = (retour: unknown[] | Error) => {
    const appels: unknown[] = [];
    return { appels, x: { execute: async (q: unknown) => { appels.push(q); if (retour instanceof Error) throw retour; return retour; } } as never };
  };
  // Règle remplacée (carte #767) : le lot 113Z rendait `false` quand les colonnes manquaient
  // (« la note est écrite, sans drapeau ») ; l'écriture est désormais REFUSÉE, dans la transaction.
  it('colonnes absentes : `markNotesUserOwned` lève (plus de `false` silencieux) et n’exécute rien', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    base.sonde = [{ n: 0 }];
    const e = exec([{ id: 5 }]);
    await expect(store.markNotesUserOwned(e.x, 7, 5)).rejects.toMatchObject({ code: 'NOTES_INTENT_UNAVAILABLE', reason: 'SCHEMA_MISSING' });
    expect(e.appels).toHaveLength(0);
  });
  it('schéma illisible : refus SCHEMA_UNKNOWN', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    base.sonde = new Error('connexion perdue');
    await expect(store.markNotesUserOwned(exec([]).x, 7, 5)).rejects.toBeInstanceOf(store.NotesIntentUnavailableError);
    await expect(store.assertNotesIntentPersistable()).rejects.toMatchObject({ reason: 'SCHEMA_UNKNOWN' });
  });
  it('écriture du drapeau en échec ou sans ligne : refus WRITE_FAILED (la transaction de la note est annulée par l’appelant)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(store.markNotesUserOwned(exec(new Error('deadlock detected')).x, 7, 5)).rejects.toMatchObject({ reason: 'WRITE_FAILED' });
    await expect(store.markNotesUserOwned(exec([]).x, 7, 5)).rejects.toMatchObject({ reason: 'WRITE_FAILED' });
  });
  it('schéma prêt : drapeau et date écrits ensemble, bornés au compte', async () => {
    const e = exec([{ id: 5 }]);
    expect(await store.markNotesUserOwned(e.x, 7, 5)).toBe(true);
    expect(e.appels).toHaveLength(1);
    expect(lire('src/services/documents/notes-description/store.ts')).toMatch(/UPDATE asset_files SET notes_user_owned = true, notes_updated_at = now\(\)\s+WHERE id = \$\{fileId\} AND account_id = \$\{accountId\} RETURNING id/);
  });
  it('les lectures de l’application ne sont pas bloquées par un schéma incomplet (valeurs neutres)', async () => {
    base.sonde = [{ n: 0 }];
    expect(await store.readNotesDescriptionMeta(7, 5)).toMatchObject({ notesUserOwned: false, descriptionSource: null });
  });
});

describe('L114Z-U-VALID — E04 : validation du texte libre (plus de troncature silencieuse)', () => {
  const de = (n: number, c = 'a') => c.repeat(n);
  it('0 caractère, absent, null, blancs → aucune note', () => {
    for (const v of ['', undefined, null, '   \n ']) expect(lib.validateNotesInput(v)).toEqual({ ok: true, notes: null });
  });
  it('1 et 5 000 caractères → acceptés, texte ENTIER', () => {
    expect(lib.validateNotesInput('x')).toEqual({ ok: true, notes: 'x' });
    const r = lib.validateNotesInput(de(5000));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.notes?.length).toBe(5000);
  });
  it('5 001 caractères → refus explicite avec la limite ; rien n’est tronqué', () => {
    expect(lib.validateNotesInput(de(5001))).toEqual({
      ok: false, code: 'NOTES_TOO_LONG', message: 'Notes / Description : 5000 caractères au plus', max: 5000, length: 5001,
    });
  });
  it('Unicode : accents et caractères hors plan de base comptés comme le champ de saisie (unités UTF-16)', () => {
    expect(lib.validateNotesInput(de(5000, 'é'))).toMatchObject({ ok: true });
    expect(lib.validateNotesInput(de(2500, '🏠'))).toMatchObject({ ok: true });   // 2 500 × 2 unités = 5 000
    expect(lib.validateNotesInput(de(2501, '🏠'))).toMatchObject({ ok: false, code: 'NOTES_TOO_LONG', length: 5002 });
    const r = lib.validateNotesInput('Chaudière — révision ✔ 🏠');
    expect(r.ok && r.notes).toBe('Chaudière — révision ✔ 🏠');
  });
  it('ancien champ `description` (client antérieur) : lu comme texte libre de l’utilisateur, mêmes règles', () => {
    expect(lib.validateNotesInput(undefined, ' Ancien « Titre / Description » ')).toEqual({ ok: true, notes: 'Ancien « Titre / Description »' });
    expect(lib.validateNotesInput(null, de(5001))).toMatchObject({ ok: false, code: 'NOTES_TOO_LONG' });
    // `notes` renseigné prime : l'ancien champ n'est alors pas écrit.
    expect(lib.validateNotesInput('Note', 'Ancien')).toEqual({ ok: true, notes: 'Note' });
  });
  it('type invalide → refus (jamais converti en texte)', () => {
    for (const v of [12, {}, ['a'], true]) expect(lib.validateNotesInput(v)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(lib.validateNotesInput('ok', 12)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
  it('même message que la modification d’un document (lot 113Z)', () => {
    expect(lire('src/app/api/documents/[id]/route.ts')).toContain('`Notes / Description : ${NOTES_MAX_LENGTH} caractères au plus`');
    expect(lib.NOTES_TOO_LONG_MESSAGE).toBe('Notes / Description : 5000 caractères au plus');
  });
});

describe('L114Z-U-STATIC — routes : fail-closed, validation, erreur explicite', () => {
  const transmission = lire('src/app/api/transmission/[token]/route.ts');
  it('E02 : plus de `.catch(() => new Map())` ; lecture stricte ; refus 503 avant la réservation', () => {
    expect(transmission).not.toMatch(/\.catch\(\(\) => new Map\(\)\)/);
    expect(transmission).not.toContain('readNotesDescriptionMetaMany');
    expect(transmission).toMatch(/readCurrentNotesDescriptionManyStrict\(row\.accountId, docsToTransfer\.map\(\(d\) => d\.id\), `transmission \$\{row\.id\}`\)/);
    expect(transmission.indexOf("error: 'NOTES_DESCRIPTION_UNAVAILABLE'")).toBeLessThan(transmission.indexOf('RÉSERVATION DE L\'ACCEPTATION'));
    // L'instantané (figé à l'envoi) ne sert plus de valeur de repli : seules les valeurs relues comptent.
    expect(transmission).toMatch(/notesDescriptionForThirdParty\(courant \?\? \{\}, inclureNotes && !!courant\)/);
  });
  it('E02 : la création refuse aussi (rien n’est créé ni envoyé)', () => {
    const creation = lire('src/app/api/assets/[id]/transmission/route.ts');
    expect(creation).toMatch(/includeNotesDescription: body\.selectedPayload\?\.includeNotesDescription === true/);
    expect(creation.indexOf("error: 'NOTES_DESCRIPTION_UNAVAILABLE'")).toBeLessThan(creation.indexOf('.insert(assetTransmissions)'));
  });
  it('E04 : plus aucune troncature `.slice(0, NOTES_MAX_LENGTH)` à l’import ni au lien web', () => {
    for (const f of ['src/app/api/files/confirm/route.ts', 'src/app/api/web-links/route.ts']) {
      const s = lire(f);
      expect(s, f).not.toMatch(/\.slice\(0, NOTES_MAX_LENGTH\)/);
      expect(s, f).toMatch(/validateNotesInput\(notes, description\)/);
      expect(s, f).toMatch(/status: 400/);
    }
    // Validation AVANT toute écriture de l'import.
    const confirm = lire('src/app/api/files/confirm/route.ts');
    expect(confirm.indexOf('validateNotesInput(notes, description)')).toBeLessThan(confirm.indexOf('updateData.notes = noteEcrite'));
  });
  it('E04 : l’interface borne la saisie à la même limite (import et tiroir)', () => {
    expect(lire('src/components/documents/unified-document-dialog.tsx')).toMatch(/maxLength=\{NOTES_MAX_LENGTH\}/);
    expect(lire('src/components/assets/DocumentDrawer.tsx')).toMatch(/maxLength=\{NOTES_MAX_LENGTH\}/);
  });
  it('E05 : les trois routes d’écriture rendent une erreur explicite (503) quand l’intention ne peut pas être persistée', () => {
    for (const f of ['src/app/api/files/confirm/route.ts', 'src/app/api/web-links/route.ts', 'src/app/api/documents/[id]/route.ts']) {
      const s = lire(f);
      expect(s, f).toMatch(/error instanceof NotesIntentUnavailableError/);
      expect(s, f).toMatch(/NOTES_INTENT_UNAVAILABLE_MESSAGE \}, \{ status: 503 \}/);
    }
    // Lien web : création et reprise en main dans la même transaction (tout ou rien).
    expect(lire('src/app/api/web-links/route.ts')).toMatch(/db\.transaction\(async \(tx\) => \{[\s\S]*markNotesUserOwned\(tx, accountId, crees\[0\]\.id\)/);
    expect(lire('src/app/api/documents/[id]/route.ts')).toMatch(/markNotesUserOwned\(tx, accountIdEcriture, documentId\)/);
  });
});

describe('L114Z-U-HEALTH — E05 : alerte de disponibilité du schéma', () => {
  it('colonnes indispensables manquantes → MISSING, noms listés', () => {
    expect(sante.notesSchemaStateFromColumns([...sante.NOTES_DESCRIPTION_ALL_COLUMNS])).toEqual({ state: 'READY', missingColumns: [] });
    expect(sante.notesSchemaStateFromColumns(['description_source', 'description_t1_status'])).toMatchObject({ state: 'MISSING', missingColumns: expect.arrayContaining(['notes_user_owned']) });
    // Colonne de trace seule manquante : écriture d'intention encore possible, mais signalée.
    expect(sante.notesSchemaStateFromColumns(['notes_user_owned', 'description_source', 'description_t1_status']))
      .toEqual({ state: 'READY', missingColumns: ['notes_updated_at', 'description_t1_status_at', 'description_t1_run_id'] });
  });
  it('base illisible → UNKNOWN (ne lève jamais)', async () => {
    base.sonde = new Error('connexion refusée');
    expect(await sante.readNotesDescriptionSchemaHealth()).toMatchObject({ state: 'UNKNOWN', appliedMigrations: null, userOwnedDocuments: null });
  });
  it('affichée dans BO › Exploitation › Santé, avec ses conséquences', () => {
    expect(lire('src/services/admin/ops/health-admin.service.ts')).toMatch(/notesDescriptionSchema: await withDeadline\(readNotesDescriptionSchemaHealth\(\), BUDGET_MS\)/);
    const panneau = lire('src/app/admin/exploitation/_components/HealthPanel.tsx');
    expect(panneau).toContain('ops-health-notes-description-alert');
    expect(panneau).toMatch(/INCOMPLÈTES — migration non appliquée/);
  });
  it('migration 1704 : additive, idempotente, aucune donnée écrite', () => {
    const m = lire('src/db/migrations/1704_l114z_notes_description_surete.sql');
    expect(m.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(6);
    const sansCommentaires = m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sansCommentaires).not.toMatch(/\b(UPDATE|DELETE|INSERT|DROP)\b/i);
    expect(sante.NOTES_DESCRIPTION_MIGRATIONS).toContain('1704_l114z_notes_description_surete.sql');
  });
});
