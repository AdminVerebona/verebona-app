/**
 * Lot 50 — ticket « Mascotte : fiabiliser les sujets affichés et le contexte
 * transmis à T6 » (tests unitaires ; base réelle :
 * `l50-mascotte-sujets-contexte.e2e.ts`).
 *
 * MASC50-AC01 : file « À traiter » non vide sans DO_FIRST → « Aucun sujet à
 *               traiter en priorité aujourd’hui. », jamais « urgent ».
 * MASC50-AC04 : visibilité déclarée par CHAQUE appelant de l'analyse (aucune
 *               exception par origine dans la mascotte) ; règle SQL.
 * MASC50-AC05 : échéance certaine sans rendez-vous → DEADLINE + confirmée,
 *               « … est à prévoir pour le 18 avril 2028. ».
 * MASC50-AC06 : événement planifié → SCHEDULED_EVENT, « prévu le … ».
 * MASC50-AC07 : date prévisionnelle → estimée, toujours.
 * MASC50-AC08 : T6 reçoit exactement les sujets sélectionnés par le serveur.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildCandidates, type MascotAgendaRow, type MascotRawData } from '../signals';
import { selectSubjects } from '../selector';
import { buildPresentation } from '../presentation';
import { composeSpeech, NOTHING_PRIORITY, tileFor } from '../bubble';
import { buildT6Input, nuanceViolation } from '../t6-contract';
import { deadlineNextText, deadlinePairText } from '../deadline-label';
import { agendaDateRole } from '@/services/agenda/agenda-date-role';
import {
  MARK_ANALYSIS_VISIBILITY_SQL, normalizeProcessingVisibility, userVisibleAnalysisSql,
} from '@/services/ai/processing-status/processing-visibility';

const TODAY = '2026-10-12';
const CUPRA = { title: 'Prochain contrôle technique — CUPRA LEON E-HYBRID180', assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture' };

const raw = (over: Partial<MascotRawData> = {}): MascotRawData => ({
  accountId: 7, today: TODAY,
  processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Cupra' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda: [], acknowledgments: [], ...over,
});
const row = (over: Partial<MascotAgendaRow>): MascotAgendaRow => ({
  id: 1, ...CUPRA, date: '2028-04-18', forecast: false, requiresQualification: false, assetId: 1, ...over,
});

describe('MASC50-AC01 — aucun « urgent » dans les textes de la mascotte', () => {
  it('file non vide, aucun DO_FIRST : priorité, jamais urgence', () => {
    const p = { status: 'ok', paragraphs: [], secondaries: [], todo: { items: [], total: 4 } } as never;
    const t = composeSpeech({ presentation: p, empty: false }).text;
    expect(t).toBe('Aucun sujet à traiter en priorité aujourd’hui.');
    expect(NOTHING_PRIORITY).toBe(t);
    expect(t).not.toMatch(/urgen/i);
  });

  it('aucun texte écrit par le code de la mascotte n’emploie « urgent » / « urgence »', () => {
    const dir = join(process.cwd(), 'src/services/home/mascot');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        // Libellés techniques admis : arrêt d'urgence (BO), motif du validateur T6.
        .replace(/arr[êe]t d[’']urgence/gi, '').replace(/const ALARME = .*$/m, '');
      const chaines = code.match(/(['`])(?:\\.|(?!\1).)*\1/g) ?? [];
      for (const c of chaines) expect(`${f}: ${c}`).not.toMatch(/urgen/i);
    }
  });
});

describe('MASC50-AC04 — visibilité du traitement, générique', () => {
  /** Appels de production de l'analyse : chaque appelant DÉCLARE sa visibilité. */
  it('chaque appelant de production déclare processingVisibility (aucune déduction par origine)', () => {
    const racines = ['src/app', 'src/services'].map((r) => join(process.cwd(), r));
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== '__fixtures__') parcourir(p); continue; }
        if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) fichiers.push(p);
      }
    };
    racines.forEach(parcourir);
    const appels: string[] = [];
    for (const f of fichiers) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\b(analyzeFileSources|enqueueFileAnalyses)\(/g)) {
        const avant = s.slice(Math.max(0, m.index! - 30), m.index!);
        if (/function\s+$|import\s*\(|\{\s*$/.test(avant) && /function/.test(avant)) continue;
        // Texte de l'appel jusqu'à sa parenthèse fermante (profondeur).
        let prof = 0, fin = m.index! + m[0].length - 1;
        for (let i = fin; i < s.length; i++) {
          if (s[i] === '(') prof++;
          else if (s[i] === ')' && --prof === 0) { fin = i; break; }
        }
        const appel = s.slice(m.index!, fin + 1);
        const rel = relative(process.cwd(), f);
        // Relais internes : héritent de la visibilité reçue (remise en file, report, exécution de la file).
        if (/entrypoint\.ts$|t1-handler\.ts$/.test(rel)) continue;
        appels.push(rel);
        expect(/processingVisibility/.test(appel), `${rel} : visibilité non déclarée`).toBe(true);
      }
    }
    expect(appels.length).toBeGreaterThanOrEqual(12);
    // Les deux appelants du ticket sont TECHNICAL.
    const put = readFileSync(join(process.cwd(), 'src/app/api/documents/[id]/route.ts'), 'utf8');
    expect(put).toMatch(/origin: 'documents\/PUT',[\s\S]{0,200}processingVisibility: 'TECHNICAL'/);
    const depot = readFileSync(join(process.cwd(), 'src/app/api/files/confirm/route.ts'), 'utf8');
    expect(depot).toMatch(/processingVisibility: 'USER'/);
  });

  it('la mascotte ne lit aucune origine : seule la visibilité filtre', () => {
    const collector = readFileSync(join(process.cwd(), 'src/services/home/mascot/collector.ts'), 'utf8');
    expect(collector).not.toMatch(/documents\/PUT|bulk-move|referential-upgrade|analysis-recovery/);
    expect(collector).toMatch(/userVisibleAnalysisSql\('f'/);
    // L'état effectif n'est pas modifié (l'analyse reste « en cours » ailleurs).
    const effectif = readFileSync(join(process.cwd(), 'src/services/ai/processing-status/effective-state-sql.ts'), 'utf8');
    expect(effectif).not.toMatch(/analysis_visibility/);
  });

  it('SQL : USER s’impose, TECHNICAL ne déclasse pas un document jamais analysé ; colonne absente → tout visible', () => {
    expect(MARK_ANALYSIS_VISIBILITY_SQL).toMatch(/WHEN \$3::text = 'USER' THEN 'USER'\s+WHEN last_analysis_at IS NULL THEN analysis_visibility\s+ELSE 'TECHNICAL'/);
    expect(MARK_ANALYSIS_VISIBILITY_SQL).not.toMatch(/updated_at/);
    expect(userVisibleAnalysisSql('f', true)).toBe("(COALESCE(f.analysis_visibility, 'USER') = 'USER')");
    expect(userVisibleAnalysisSql('f', false)).toBe('TRUE');
    expect(() => userVisibleAnalysisSql('f; DROP', true)).toThrow();
    expect(normalizeProcessingVisibility(undefined)).toBe('USER');
    expect(normalizeProcessingVisibility('TECHNICAL')).toBe('TECHNICAL');
    expect(normalizeProcessingVisibility('autre')).toBe('USER');
  });
});

describe('Rôle de la date — données structurées, jamais le titre', () => {
  const base = { forecast: false, isAutomatic: false, originType: 'manual', projectionOrigin: null, eventNature: null, startTime: null };
  it.each([
    ['échéance automatique (champ du bien)', { isAutomatic: true, originType: 'asset_field' }, 'DEADLINE'],
    ['nature T4 DEADLINE', { isAutomatic: true, originType: 'qualified_document', eventNature: 'DEADLINE' }, 'DEADLINE'],
    ['projection d’une Opération', { isAutomatic: true, originType: 'deduced_rule', projectionOrigin: 'OPERATION' }, 'DEADLINE'],
    ['prévision, même saisie', { forecast: true }, 'DEADLINE'],
    ['échéance saisie avec nature DEADLINE', { eventNature: 'DEADLINE' }, 'DEADLINE'],
    ['événement saisi par l’utilisateur', {}, 'SCHEDULED_EVENT'],
    ['événement historique migré', { originType: 'legacy_event_migration' }, 'SCHEDULED_EVENT'],
    ['heure fixée, même automatique', { isAutomatic: true, originType: 'qualified_document', startTime: '09:30' }, 'SCHEDULED_EVENT'],
    ['ancienne échéance migrée', { originType: 'legacy_deadline_migration' }, 'DEADLINE'],
  ])('%s', (_l, over, attendu) => {
    expect(agendaDateRole({ ...base, ...over })).toBe(attendu);
  });
  it('le titre n’intervient pas', () => {
    expect(agendaDateRole({ ...base, isAutomatic: true, originType: 'asset_field' })).toBe('DEADLINE');
    const src = readFileSync(join(process.cwd(), 'src/services/agenda/agenda-date-role.ts'), 'utf8');
    expect(src).not.toMatch(/\.title\b/);
  });
});

describe('MASC50-AC05 — échéance future certaine, aucun rendez-vous', () => {
  it('faits : DEADLINE + confirmée ; repli « à prévoir pour le »', () => {
    const s = buildCandidates(raw({ agenda: [row({ dateRole: 'DEADLINE' })] })).candidates.find((c) => c.sourceCode === 'DATE-NEXT')!;
    expect(s.facts).toMatchObject({ dateRole: 'DEADLINE', dateNature: 'confirmée' });
    expect(s.fallbackText).toBe('Le prochain contrôle technique de la Cupra est à prévoir pour le 18 avril 2028.');
    expect(s.fallbackText).not.toMatch(/rendez-vous|est prévu/);
    expect(tileFor(s, TODAY).status).toBe('À prévoir pour le 18 avril 2028');
  });
  it('rôle absent (lecture antérieure) → DEADLINE, jamais présenté comme organisé', () => {
    const s = buildCandidates(raw({ agenda: [row({})] })).candidates.find((c) => c.sourceCode === 'DATE-NEXT')!;
    expect(s.facts.dateRole).toBe('DEADLINE');
  });
  it('terme d’une période : « fixée au »', () => {
    expect(deadlineNextText({ title: 'Fin de contrat — Matmut', assetName: null, forecast: false, dateRole: 'DEADLINE' }, '18 avril 2028'))
      .toBe('La fin de contrat Matmut est fixée au 18 avril 2028.');
  });
});

describe('MASC50-AC06 — événement réellement planifié', () => {
  it('SCHEDULED_EVENT : « prévu le », jamais « à prévoir »', () => {
    const s = buildCandidates(raw({ agenda: [row({ title: 'Rendez-vous garage', dateRole: 'SCHEDULED_EVENT' })] }))
      .candidates.find((c) => c.sourceCode === 'DATE-NEXT')!;
    expect(s.facts).toMatchObject({ dateRole: 'SCHEDULED_EVENT', dateNature: 'confirmée' });
    expect(s.fallbackText).toBe('Le rendez-vous garage de la Cupra est prévu le 18 avril 2028.');
    expect(s.fallbackText).not.toMatch(/à prévoir/);
    expect(tileFor(s, TODAY).status).toBe('Prévu le 18 avril 2028');
  });
  it('genre inconnu : formulation neutre, toujours « prévu »', () => {
    expect(deadlineNextText({ title: 'Audit', assetName: 'Cupra', forecast: false, dateRole: 'SCHEDULED_EVENT' }, '18 avril 2028'))
      .toBe('Prévu le 18 avril 2028 pour Cupra : Audit.');
  });
  it('DATE-NEXT-2 : rôles distincts transmis, phrase adaptée', () => {
    const a = row({ id: 1, dateRole: 'DEADLINE' });
    const b = row({ id: 2, title: 'Rendez-vous garage', dateRole: 'SCHEDULED_EVENT' });
    const s = buildCandidates(raw({ agenda: [a, b] })).candidates.find((c) => c.sourceCode === 'DATE-NEXT-2')!;
    expect(s.facts).toMatchObject({ firstDateRole: 'DEADLINE', secondDateRole: 'SCHEDULED_EVENT' });
    expect(s.fallbackText).toMatch(/^Deux dates sont à noter le 18 avril 2028 : /);
    expect(deadlinePairText({ ...b }, { ...b }, '18 avril 2028', false)).toMatch(/^Deux événements sont prévus le 18 avril 2028 : /);
  });
});

describe('MASC50-AC07 — date prévisionnelle', () => {
  it('reste estimée, même pour un rôle SCHEDULED_EVENT déclaré', () => {
    const s = buildCandidates(raw({ agenda: [row({ forecast: true, dateRole: 'SCHEDULED_EVENT' })] }))
      .candidates.find((c) => c.sourceCode === 'DATE-NEXT')!;
    expect(s.facts).toMatchObject({ dateRole: 'DEADLINE', dateNature: 'prévisionnelle' });
    expect(s.fallbackText).toBe('Le prochain contrôle technique de la Cupra est à prévoir autour du 18 avril 2028 (date estimée).');
    expect(tileFor(s, TODAY).status).toBe('À prévoir pour le 18 avril 2028 (estimée)');
  });
});

describe('MASC50-AC08 — T6 reçoit exactement les sujets sélectionnés', () => {
  it('entrée T6 = sélection du serveur, faits inclus ; aucun sujet technique ajouté', () => {
    const r = raw({
      agenda: [row({ dateRole: 'DEADLINE' })],
      processing: { uploads: [], analyses: [{ id: 9, title: 'Facture.pdf', at: `${TODAY}T08:00:00Z` }], exports: [] },
    });
    const cands = buildCandidates(r);
    const sel = selectSubjects(cands.candidates);
    const input = buildT6Input(sel);
    expect(input.subjects.map((s) => s.subjectId)).toEqual(sel.map((s) => s.subjectId));
    expect(input.subjects.map((s) => s.facts)).toEqual(sel.map((s) => s.facts));
    // Une analyse filtrée en amont (technique) n'existe pas dans les données : jamais de sujet.
    const sansTechnique = selectSubjects(buildCandidates({ ...r, processing: { uploads: [], analyses: [], exports: [] } }).candidates);
    expect(buildT6Input(sansTechnique).subjects.some((s) => s.sourceCode === 'PROC-DOC-ANALYSIS')).toBe(false);
    expect(buildPresentation).toBeTypeOf('function');
  });

  it('garde T6 : une date à respecter n’est jamais présentée comme un rendez-vous', () => {
    const s = buildT6Input(buildCandidates(raw({ agenda: [row({ dateRole: 'DEADLINE' })] })).candidates
      .filter((c) => c.sourceCode === 'DATE-NEXT')).subjects[0];
    expect(nuanceViolation('Votre rendez-vous pour le contrôle technique de la Cupra est le 18 avril 2028.', s, 'info')).toBe('deadline_as_appointment');
    expect(nuanceViolation('Le contrôle technique de la Cupra est à prévoir pour le 18 avril 2028.', s, 'info')).toBeNull();
    const planifie = buildT6Input(buildCandidates(raw({ agenda: [row({ title: 'Rendez-vous garage', dateRole: 'SCHEDULED_EVENT' })] })).candidates
      .filter((c) => c.sourceCode === 'DATE-NEXT')).subjects[0];
    expect(nuanceViolation('Votre rendez-vous au garage pour la Cupra est le 18 avril 2028.', planifie, 'info')).toBeNull();
  });
});
