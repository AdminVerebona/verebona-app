/**
 * Lot 113Z (Trello #723) — « Notes / Description » : champ unique, T1, dossiers tiers.
 *
 *   L113Z-U-RESOLVE  priorité notes > description T1 > vide ; vide volontaire ; provenance établie seulement ;
 *   L113Z-U-EDIT     ouvrir/enregistrer sans modifier → rien ; modifié → note ; effacé → vide explicite ;
 *   L113Z-U-T1       décision d'écriture de la description T1 (provenance, origine inconnue conservée, verrou) ;
 *   L113Z-U-TOLERANT description mal formée retirée SEULE, extraction valide conservée ;
 *   L113Z-U-TIERS    transmission / dossiers tiers : exclu par défaut, texte affiché seul sur inclusion ;
 *   L113Z-U-DIAG     verdicts de la chaîne (aucune cause non prouvée) ;
 *   L113Z-U-COH      contrôle COH-DOC-DESCRIPTION-T1 en fin de registre, couvert, interdits ;
 *   L113Z-U-GUIDE    bloc 27 du guide applicable au prompt T1 livré, exemple accepté par le schéma réel ;
 *   L113Z-U-T2       note de l'Assistant avec provenance « déclarée par l'utilisateur » ;
 *   L113Z-U-STATIC   tiroir / import / route / dossiers V12 : plus de double saisie ni de description envoyée.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: () => Promise.reject(new Error('pas de base')) } }));

const lib = await import('@/lib/documents/notes-description');
const t1 = await import('../t1-description');
const tiers = await import('../third-party');

const racine = process.cwd();
const lire = (f: string) => readFileSync(join(racine, f), 'utf8');

describe('L113Z-U-RESOLVE — ce qu’affiche « Notes / Description »', () => {
  it('libellé repris à l’identique du ticket', () => {
    expect(lib.NOTES_DESCRIPTION_LABEL).toBe('Notes / Description');
  });
  it('description T1 établie, sans note → préremplie, provenance IA (recette 1)', () => {
    expect(lib.resolveNotesDescription({ description: 'Facture d’entretien', descriptionSource: 'T1' }))
      .toEqual({ text: 'Facture d’entretien', origin: 'AI', userOwned: false, fromNotes: false });
  });
  it('ni description ni note → vide, sans provenance (recette 2)', () => {
    expect(lib.resolveNotesDescription({ notes: null, description: '  ' })).toEqual({ text: '', origin: null, userOwned: false, fromNotes: false });
  });
  it('note utilisateur prioritaire sur la description (recette 4)', () => {
    expect(lib.resolveNotesDescription({ notes: 'Ma note', description: 'IA', descriptionSource: 'T1' })).toMatchObject({ text: 'Ma note', origin: 'USER', fromNotes: true });
  });
  it('vide volontaire : la description ne réapparaît pas (recette 5)', () => {
    expect(lib.resolveNotesDescription({ notes: null, notesUserOwned: true, description: 'IA', descriptionSource: 'T1' }))
      .toEqual({ text: '', origin: 'USER', userOwned: true, fromNotes: true });
  });
  it('description historique d’origine inconnue : conservée, jamais présentée comme IA (recette 9)', () => {
    expect(lib.resolveNotesDescription({ description: 'Ancienne saisie', descriptionSource: null })).toMatchObject({ text: 'Ancienne saisie', origin: 'UNKNOWN' });
  });
});

describe('L113Z-U-EDIT — écriture depuis l’édition', () => {
  it('ouvrir / enregistrer sans modifier → aucune écriture (recette 3)', () => {
    expect(lib.notesWriteFromEdit('Texte IA', 'Texte IA')).toEqual({ write: false });
    expect(lib.notesWriteFromEdit('Texte IA  ', 'Texte IA')).toEqual({ write: false });
    expect(lib.notesWriteFromEdit('', '   ')).toEqual({ write: false });
    expect(lib.notesWriteFromEdit('a\r\nb', 'a\nb')).toEqual({ write: false });
  });
  it('texte modifié → note de l’utilisateur', () => {
    expect(lib.notesWriteFromEdit('Texte IA', 'Texte IA corrigé')).toEqual({ write: true, notes: 'Texte IA corrigé', cleared: false });
  });
  it('effacement volontaire → vide explicite', () => {
    expect(lib.notesWriteFromEdit('Texte IA', '')).toEqual({ write: true, notes: null, cleared: true });
  });
});

describe('L113Z-U-T1 — description T1 : écriture, provenance, constat', () => {
  const base = { current: null, currentSource: null, previousExtraction: null, userLocked: false };
  it('absente → ABSENT, aucune écriture (jamais d’effacement)', () => {
    expect(t1.decideT1Description({ ...base, produced: null, current: 'X' })).toEqual({ write: false, status: 'ABSENT', setSourceT1: false });
  });
  it('retirée à la validation → REMOVED_AT_VALIDATION', () => {
    expect(t1.decideT1Description({ ...base, produced: '', removedAtValidation: true }).status).toBe('REMOVED_AT_VALIDATION');
  });
  it('colonne vide → écrite, provenance T1', () => {
    expect(t1.decideT1Description({ ...base, produced: 'Desc' })).toEqual({ write: true, status: 'PRODUCED', setSourceT1: true });
  });
  it('description T1 établie → mise à jour (T1 peut faire évoluer sa description interne)', () => {
    expect(t1.decideT1Description({ ...base, produced: 'Nouvelle', current: 'Ancienne', currentSource: 'T1' }).write).toBe(true);
  });
  it('description égale à la sortie T1 précédente → provenance prouvée, mise à jour', () => {
    expect(t1.decideT1Description({ ...base, produced: 'Nouvelle', current: 'Ancienne', previousExtraction: 'Ancienne' })).toMatchObject({ write: true, setSourceT1: true });
  });
  it('origine inconnue différente → conservée (KEPT_UNKNOWN_ORIGIN)', () => {
    expect(t1.decideT1Description({ ...base, produced: 'Nouvelle', current: 'Saisie historique', previousExtraction: 'Autre' }))
      .toEqual({ write: false, status: 'KEPT_UNKNOWN_ORIGIN', setSourceT1: false });
  });
  it('verrou utilisateur → KEPT_USER_LOCKED', () => {
    expect(t1.decideT1Description({ ...base, produced: 'Nouvelle', userLocked: true }).status).toBe('KEPT_USER_LOCKED');
  });
  it('retrait lu dans les éléments non résolus (jamais une valeur réduite conservée)', () => {
    expect(t1.descriptionRemovedAtValidation([{ rawKey: 'document.description', status: 'UNRESOLVED' }])).toBe(true);
    expect(t1.descriptionRemovedAtValidation([{ rawKey: 'document.description.value', status: 'RETAINED' }])).toBe(false);
    expect(t1.descriptionRemovedAtValidation([{ detail: 'valeur retirée par la normalisation (document.title)', status: 'UNRESOLVED' }])).toBe(false);
    expect(t1.descriptionRemovedAtValidation(undefined)).toBe(false);
  });
  it('reprise de l’historique et provenance prouvable (purs)', () => {
    expect(t1.recoverableFromExtraction({ current: null, extraction: 'Desc', userLocked: false })).toBe(true);
    expect(t1.recoverableFromExtraction({ current: null, extraction: 'Desc', userLocked: true })).toBe(false);
    expect(t1.provenanceProvable({ current: ' Desc ', currentSource: null, extraction: 'Desc' })).toBe(true);
    expect(t1.provenanceProvable({ current: 'Saisie', currentSource: null, extraction: 'Desc' })).toBe(false);
  });
});

describe('L113Z-U-TOLERANT — l’absence ou le défaut de résumé ne fait pas échouer l’extraction', async () => {
  const { T1AnalyzeDocumentTolerantOutput, splitNormalisation } = await import('@/services/ai/source-analysis/master/tolerant-output');
  const doc = (description: unknown) => ({
    task: 'ANALYZE_DOCUMENT',
    document: { title: { value: 'Facture', confidence: 'certain', evidence: {} }, description },
  });
  it('description en simple chaîne (méta manquante) → retirée seule, original conservé', () => {
    const { output, report } = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(doc('Texte libre')));
    expect(output.document.description).toBeUndefined();
    expect(output.document.title?.value).toBe('Facture');
    expect(report?.originals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'REMOVED', path: 'document.description' })]));
  });
  it('confiance hors vocabulaire → retirée seule ; valeur vide → absente', () => {
    expect(splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(doc({ value: 'x', confidence: 'haute' }))).output.document.description).toBeUndefined();
    expect(splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(doc({ value: '', confidence: 'certain' }))).output.document.description).toBeUndefined();
  });
  it('description valide conservée telle quelle', () => {
    const { output } = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(doc({ value: 'Entretien chaudière', confidence: 'certain', evidence: { excerpt: 'Entretien' } })));
    expect(output.document.description?.value).toBe('Entretien chaudière');
  });
});

describe('L113Z-U-TIERS — dossiers et transmission à un tiers', () => {
  const doc = { notes: 'Note perso', description: 'Desc IA', descriptionSource: 'T1', notesUserOwned: true };
  it('exclu par défaut, quelle que soit l’origine (recette 11)', () => {
    expect(tiers.THIRD_PARTY_NOTES_DESCRIPTION_DEFAULT).toBe(false);
    for (const inc of [undefined, null, false]) {
      expect(tiers.notesDescriptionForThirdParty(doc, inc)).toEqual({ notes: null, description: null, notesUserOwned: false, descriptionSource: null });
      expect(tiers.notesDescriptionForThirdParty({ description: 'Desc IA', descriptionSource: 'T1' }, inc).description).toBeNull();
    }
  });
  it('inclusion explicite → le texte AFFICHÉ seul', () => {
    expect(tiers.notesDescriptionForThirdParty(doc, true)).toEqual({ notes: 'Note perso', description: null, notesUserOwned: true, descriptionSource: null });
    expect(tiers.notesDescriptionForThirdParty({ description: 'Desc IA', descriptionSource: 'T1' }, true)).toEqual({ notes: null, description: 'Desc IA', notesUserOwned: false, descriptionSource: 'T1' });
    expect(tiers.notesDescriptionForThirdParty({ description: 'Ancienne', descriptionSource: null }, true).descriptionSource).toBeNull();
    // Vide volontaire : rien ne part, pas même la description masquée.
    expect(tiers.notesDescriptionForThirdParty({ notes: null, notesUserOwned: true, description: 'Desc IA', descriptionSource: 'T1' }, true).description).toBeNull();
  });
});

describe('L113Z-U-DIAG — chaîne de la description (recette 13)', () => {
  const base = { runExists: true, runDescription: 'Desc', removedAtValidation: false, extraction: 'Desc', current: 'Desc', t1Status: null, userLocked: false };
  it('verdicts prouvés par les données', () => {
    expect(t1.diagnoseDescriptionChain({ ...base, runExists: false })).toBe('NO_ANALYSIS');
    expect(t1.diagnoseDescriptionChain({ ...base, runDescription: null, extraction: null, current: null })).toBe('NOT_GENERATED');
    expect(t1.diagnoseDescriptionChain({ ...base, runDescription: null, removedAtValidation: true })).toBe('REMOVED_AT_VALIDATION');
    expect(t1.diagnoseDescriptionChain({ ...base, t1Status: 'PERSIST_FAILED', current: null })).toBe('PERSIST_FAILED');
    expect(t1.diagnoseDescriptionChain(base)).toBe('CONSISTENT');
    expect(t1.diagnoseDescriptionChain({ ...base, current: 'Autre', t1Status: 'KEPT_UNKNOWN_ORIGIN' })).toBe('KEPT_UNKNOWN_ORIGIN');
    expect(t1.diagnoseDescriptionChain({ ...base, current: null, t1Status: 'PRODUCED' })).toBe('OVERWRITTEN_AFTER_T1');
  });
  it('produite puis absente sans trace (stock antérieur) → cause NON prouvée', () => {
    expect(t1.diagnoseDescriptionChain({ ...base, current: null })).toBe('MISSING_UNDETERMINED');
    expect(t1.DESCRIPTION_CHAIN_LABELS.MISSING_UNDETERMINED).toMatch(/non prouvée/);
  });
  it('sortie T1 persistée lue sans erreur', () => {
    expect(t1.runDescriptionOf(JSON.stringify({ document: { description: { value: 'D' } } }))).toBe('D');
    expect(t1.runDescriptionOf('{oups')).toBeNull();
    expect(t1.runDescriptionOf({ document: {} })).toBeNull();
  });
});

describe('L113Z-U-COH — reprise de l’historique sans IA', () => {
  it('en fin de registre, après COH-DOC-BUSINESS-PERIODS, couvert, interdits explicites', async () => {
    const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.slice(-2)).toEqual(['COH-DOC-BUSINESS-PERIODS', 'COH-DOC-DESCRIPTION-T1']);
    const c = COHERENCE_REGISTRY.at(-1)!;
    expect(c).toMatchObject({ status: 'ACTIVE', version: 1, objectType: 'document' });
    const interdits = c.forbiddenRepairs.join(' ');
    expect(interdits).toMatch(/appeler l’IA/);
    expect(interdits).toMatch(/notes/);
    expect(interdits).toMatch(/origine inconnue/);
    expect(COVERAGE_INVENTORY.some((d) => d.checks.includes('COH-DOC-DESCRIPTION-T1'))).toBe(true);
  });
  it('diagnostic pur : reprise, qualification, origine inconnue intouchée', async () => {
    const { diagnoseDocumentDescription } = await import('@/services/coherence/registry/checks/document-description-t1');
    expect(diagnoseDocumentDescription({ current: null, source: null, extraction: 'D', locked: false })).toEqual({ verdict: 'REPAIRABLE', anomaly: 'DESCRIPTION_MISSING_RECOVERABLE' });
    expect(diagnoseDocumentDescription({ current: 'D', source: null, extraction: 'D', locked: false })).toEqual({ verdict: 'REPAIRABLE', anomaly: 'DESCRIPTION_PROVENANCE_UNQUALIFIED' });
    expect(diagnoseDocumentDescription({ current: 'Saisie', source: null, extraction: 'D', locked: false })).toEqual({ verdict: 'CONSISTENT' });
    expect(diagnoseDocumentDescription({ current: 'D', source: 'T1', extraction: 'D', locked: false })).toEqual({ verdict: 'CONSISTENT' });
  });
  it('migration 1580 additive et idempotente, aucune réécriture de données', () => {
    const m = lire('src/db/migrations/1580_l113z_notes_description.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS notes_user_owned BOOLEAN NOT NULL DEFAULT false/);
    expect(m).not.toMatch(/^\s*UPDATE\s/im);
    expect(m).not.toMatch(/DROP\s/i);
  });
});

describe('L113Z-U-GUIDE — bloc 27 du guide (T1, description)', () => {
  const guide = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
  const section = guide.slice(guide.indexOf('Étape 27 — T1'), guide.indexOf('## 11. Qualification par couple'));
  const bloc = /### Texte exact à coller \(bloc 27\)\n\n```text\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
  const livre = lire('src/services/ai/prompts/source-analysis/t1_master_v1.txt');
  const REPERE = 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.';

  it('marqueur présent, absent du prompt livré, ligne repère unique', () => {
    expect(bloc).toContain(t1.T1_DOCUMENT_DESCRIPTION_CONTRACT);
    expect(livre).not.toContain(t1.T1_DOCUMENT_DESCRIPTION_CONTRACT);
    expect(livre.split(REPERE)).toHaveLength(2);
    expect(bloc).toMatch(/abstiens-toi/);
  });
  it('T1 après collage : aucun contrôle bloquant du BO, aucun emplacement inconnu', async () => {
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    expect(checkMasterPromptContent('T1', livre.replace(REPERE, `${bloc}\n\n${REPERE}`)).blocking).toEqual([]);
    expect(inspectMasterTemplate(bloc).placeholders).toEqual([]);
  });
  it('exemple accepté par le schéma réel de document.description', async () => {
    const { T1AnalyzeDocumentOutput } = await import('@/services/ai/source-analysis/master/t1-contract');
    const ex = JSON.parse(bloc.slice(bloc.indexOf('{"value"')).trim());
    expect(T1AnalyzeDocumentOutput.shape.document.removeDefault().shape.description.unwrap().parse(ex).value.length).toBeLessThanOrEqual(300);
  });
});

describe('L113Z-U-T2 — Assistant : note déclarée par l’utilisateur', async () => {
  const r = await import('@/services/verebona-assistant/registries/retrieval-adapters');
  it('provenance distincte des faits prouvés', () => {
    expect(r.userDeclaredNote('  Code portail 1234 ')).toBe(`${r.USER_NOTE_PREFIX} Code portail 1234`);
    expect(r.userDeclaredNote('')).toBeNull();
    expect(r.USER_NOTE_PREFIX).toMatch(/déclarée par l’utilisateur/);
    expect(r.USER_DECLARED_PROVENANCE).toBe('USER_DECLARED');
  });
});

describe('L113Z-U-STATIC — tiroir, import, route, dossiers', () => {
  it('tiroir : un seul champ, la description n’est plus envoyée ni effaçable', () => {
    const s = lire('src/components/assets/DocumentDrawer.tsx');
    expect(s).toContain('NOTES_DESCRIPTION_LABEL');
    expect(s).not.toMatch(/description: editDescription|<Label>Description<\/Label>|<Label>Notes<\/Label>/);
    expect(s).toMatch(/notesDescription: editNotesDescription/);
    // 113W : les périodes métier restent dans le tiroir.
    expect(s).toContain('DocumentBusinessPeriodField');
  });
  it('route PUT : `description` jamais écrite ; notes seules → pas de réanalyse', () => {
    const s = lire('src/app/api/documents/[id]/route.ts');
    expect(s).not.toMatch(/updateData\.description\s*=/);
    expect(s).toMatch(/k !== 'notes'/);
    expect(s).toMatch(/!rienPourT1\) \{\n\s*reanalyser\(\)/);
  });
  it('import : plus de « Titre / Description » ; titre et texte libre séparés', () => {
    const s = lire('src/components/documents/unified-document-dialog.tsx');
    expect(s).not.toContain('Titre / Description');
    expect(s).not.toMatch(/description: title/);
    const c = lire('src/app/api/files/confirm/route.ts');
    expect(c).not.toMatch(/updateData\.description\s*=/);
    expect(lire('src/app/api/web-links/route.ts')).not.toMatch(/description: description/);
  });
  it('dossiers V12 : aucune description documentaire dans la source des dossiers', () => {
    const s = lire('src/services/exports/v12/data/source.ts');
    const iface = s.slice(s.indexOf('export interface SourceDocument'), s.indexOf('}', s.indexOf('export interface SourceDocument')));
    expect(iface).not.toMatch(/\bdescription\??:/);
    expect(s).not.toMatch(/description: d\.description/);
  });
  it('jamais « Opération » visible dans les textes ajoutés', () => {
    for (const v of [lib.NOTES_DESCRIPTION_LABEL, tiers.THIRD_PARTY_NOTES_DESCRIPTION_OPTION_LABEL]) expect(v).not.toMatch(/Opération/);
  });
});
