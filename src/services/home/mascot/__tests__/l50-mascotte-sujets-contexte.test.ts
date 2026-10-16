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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
    // Lot 61 : « pour le moment » — formulation proportionnée.
    expect(t).toBe('Aucun sujet à traiter en priorité pour le moment.');
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
  /**
   * Appelants de production CONNUS et visibilité attendue. Un appelant hors
   * de cette liste (code local d'un dépôt) n'est pas bloquant : sans
   * déclaration, son analyse est USER — affichée, comportement antérieur.
   */
  const ATTENDUS: Readonly<Record<string, 'USER' | 'TECHNICAL'>> = {
    'src/app/api/files/confirm/route.ts': 'USER',
    'src/app/api/documents/[id]/analyze/route.ts': 'USER',
    'src/app/api/documents/analyze-batch/route.ts': 'USER',
    // Lot 64A : `triggerRetroactiveAnalysis` (jamais appelée) retirée du webhook Stripe — plus d'appel d'analyse.
    'src/services/document-ai/retroactive-analysis.service.ts': 'USER',
    'src/app/api/documents/[id]/route.ts': 'TECHNICAL',
    'src/app/api/documents/bulk-move/route.ts': 'TECHNICAL',
    'src/app/api/cron/documents/referential-upgrade/route.ts': 'TECHNICAL',
    'src/services/document-ai/analysis-recovery.service.ts': 'TECHNICAL',
    'src/services/ai/source-analysis/invalid-output-replay.job.ts': 'TECHNICAL',
    'src/services/ai/source-analysis/source-units/jobs.ts': 'TECHNICAL',
    'src/services/ai/governance/corpus/pipeline-runner.ts': 'TECHNICAL',
  };

  /** Appels réels (commentaires retirés) de l'analyse dans un fichier, texte complet de chaque appel. */
  const appelsDe = (rel: string): string[] => {
    const brut = readFileSync(join(process.cwd(), rel), 'utf8');
    const s = brut.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const out: string[] = [];
    for (const m of s.matchAll(/\b(analyzeFileSources|enqueueFileAnalyses)\(/g)) {
      if (/function\s+$/.test(s.slice(Math.max(0, m.index! - 20), m.index!))) continue;
      let prof = 0, fin = m.index! + m[0].length - 1;
      for (let i = fin; i < s.length; i++) {
        if (s[i] === '(') prof++;
        else if (s[i] === ')' && --prof === 0) { fin = i; break; }
      }
      out.push(s.slice(m.index!, fin + 1));
    }
    return out;
  };

  it('chaque appelant connu déclare la bonne visibilité (aucune déduction par origine)', () => {
    for (const [rel, attendu] of Object.entries(ATTENDUS)) {
      const appels = appelsDe(rel);
      expect(appels.length, `${rel} : aucun appel trouvé`).toBeGreaterThan(0);
      for (const a of appels) {
        expect(a.includes(`processingVisibility: '${attendu}'`), `${rel} : ${attendu} attendu`).toBe(true);
      }
    }
  });

  it('un appelant non déclaré reste USER (affiché, comportement antérieur), jamais masqué par défaut', () => {
    expect(normalizeProcessingVisibility(undefined)).toBe('USER');
    const ep = readFileSync(join(process.cwd(), 'src/services/ai/source-analysis/entrypoint.ts'), 'utf8');
    expect(ep).toMatch(/markAnalysisVisibility\(fileIds, accountId, normalizeProcessingVisibility\(options\.processingVisibility\)\)/);
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
    // Lot 53 (D27) : une heure ne prouve pas une programmation.
    ['heure fixée, même automatique', { isAutomatic: true, originType: 'qualified_document', startTime: '09:30' }, 'DEADLINE'],
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
    // Lot 55A : carte « bien · date complète » — le rôle de la date reste dit par la bulle.
    expect(tileFor(s, TODAY).status).toBe('18 avril 2028');
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
    // Lot 55A : carte « bien · date complète », jamais « à prévoir » pour un événement planifié.
    expect(tileFor(s, TODAY).status).toBe('18 avril 2028');
  });
  it('genre inconnu : formulation neutre, toujours « prévu »', () => {
    expect(deadlineNextText({ title: 'Audit', assetName: 'Cupra', forecast: false, dateRole: 'SCHEDULED_EVENT' }, '18 avril 2028'))
      .toBe('Prévu le 18 avril 2028 pour Cupra : Audit.');
  });
  it('deux dates le même jour (lot 61 : deux sujets) : rôle propre à chacune, phrase adaptée', () => {
    const a = row({ id: 1, dateRole: 'DEADLINE' });
    const b = row({ id: 2, title: 'Rendez-vous garage', dateRole: 'SCHEDULED_EVENT' });
    const [sa, sb] = buildCandidates(raw({ agenda: [a, b] })).candidates.filter((c) => c.sourceCode === 'DATE-NEXT');
    expect(sa.facts).toMatchObject({ dateRole: 'DEADLINE' });
    expect(sb.facts).toMatchObject({ dateRole: 'SCHEDULED_EVENT' });
    expect(sb.fallbackText).toMatch(/est prévu le 18 avril 2028/);
    expect(deadlinePairText({ ...b }, { ...b }, '18 avril 2028', false)).toMatch(/^Deux événements sont prévus le 18 avril 2028 : /);
  });
});

describe('MASC50-AC07 — date prévisionnelle', () => {
  it('reste estimée, même pour un rôle SCHEDULED_EVENT déclaré', () => {
    const s = buildCandidates(raw({ agenda: [row({ forecast: true, dateRole: 'SCHEDULED_EVENT' })] }))
      .candidates.find((c) => c.sourceCode === 'DATE-NEXT')!;
    expect(s.facts).toMatchObject({ dateRole: 'DEADLINE', dateNature: 'prévisionnelle' });
    expect(s.fallbackText).toBe('Le prochain contrôle technique de la Cupra est à prévoir autour du 18 avril 2028 (date estimée).');
    // Lot 55A : date complète, toujours marquée estimée (DAT-003).
    expect(tileFor(s, TODAY).status).toBe('18 avril 2028 (estimée)');
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
