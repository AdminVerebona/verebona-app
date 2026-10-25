/**
 * Lot 82B — socle du contrôle de cohérence global : registre, couverture,
 * décisions pures du moteur (anti-boucle, preuve), mode, tâche planifiée,
 * retrait de l'ancienne maintenance (C-Q9). Sans base (voir le scénario e2e
 * `l82b-controle-coherence.e2e.ts` pour l'exécution réelle).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COHERENCE_REGISTRY, activeChecks, getCheck, registryVersion } from '../registry';
import { COVERAGE_INVENTORY, C_Q1_DOMAINS } from '../registry/coverage';
import { nextProofCounters, repairAllowed, resultOfVerdict, MAX_REPAIR_RETRIES, type ProofState } from '../engine';
import { coherenceMode, dailyDeadline } from '../orchestrator';
import { fingerprintOf } from '../supervision';

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('L82B-U-REG — registre déclaratif et versionné (CDC §3.2, CA-01)', () => {
  it('L82B-U-REG-01 — identifiants uniques ; chaque contrôle porte les champs exigés', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COHERENCE_REGISTRY) {
      expect(c.id).toMatch(/^COH-[A-Z0-9-]+$/);
      for (const champ of ['title', 'domain', 'objectType', 'scope', 'applicability', 'invariant', 'autoRepairWhen', 'frequency'] as const) {
        expect(String(c[champ]).length, `${c.id}.${champ}`).toBeGreaterThan(1);
      }
      expect(c.sources.length, `${c.id}.sources`).toBeGreaterThan(0);
      expect(c.anomalies.length, `${c.id}.anomalies`).toBeGreaterThan(0);
      expect(c.forbiddenRepairs.length, `${c.id}.forbiddenRepairs`).toBeGreaterThan(0);
      expect(c.services.length, `${c.id}.services`).toBeGreaterThan(0);
      expect(c.chain.length, `${c.id}.chain`).toBeGreaterThan(0);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(c.criticality);
      if (c.status === 'ACTIVE') {
        expect(c.listObjects && c.inspect, c.id).toBeTruthy();
        expect(c.triggers.length, `${c.id}.triggers`).toBeGreaterThan(0);
        expect(c.tests.length, `${c.id}.tests`).toBeGreaterThan(0);
      }
    }
  });

  it('L82B-U-REG-02 — premiers contrôles branchés : À traiter, liens documentaires, agenda 76H, orphelins, TCO (dans cet ordre, en tête) ; point d’extension C-Q7 branché au lot 83B', () => {
    // Lot 83B : le registre s'enrichit (C-Q7, C3, C4 ; 83E en parallèle) — les contrôles 82B restent en tête, dans leur ordre.
    expect(activeChecks().map((c) => c.id).slice(0, 5)).toEqual([
      'COH-TODO-DOCUMENT-FIELDS', 'COH-DOC-LINKS', 'COH-AGENDA-OCCURRENCES', 'COH-AGENDA-ORPHANS', 'COH-TCO-EXTRACTED-EXPENSES',
    ]);
    const c7 = getCheck('COH-DOC-EXTRACT-CHAIN')!;
    expect(c7.status).toBe('ACTIVE');
    expect(c7.chain).toEqual(['EXTRACT', 'T1', 'T3', 'T4', 'PERSISTENCE']);
    // (identifiants comparés : chai appellerait la méthode `inspect` du contrôle pour le formater)
    expect(activeChecks().map((c) => c.id)).toContain(c7.id);
  });

  it('L82B-U-REG-03 — version du registre : change dès qu’une version de contrôle change (réexamen du stock, §6.4)', () => {
    const v = registryVersion();
    expect(v).toMatch(/^r1-[0-9a-f]{12}$/);
    const modifie = COHERENCE_REGISTRY.map((c) => (c.id === 'COH-DOC-LINKS' ? { ...c, version: c.version + 1 } : c));
    expect(registryVersion(modifie)).not.toBe(v);
    expect(registryVersion([...COHERENCE_REGISTRY].reverse())).toBe(v);
  });

  it('L82B-U-REG-04 (C-Q6) — aucune règle codée par type de document ni catégorie « Impôts et taxes »', () => {
    const src = ['src/services/coherence/registry/checks/tco.ts', 'src/services/coherence/engine.ts', 'src/services/coherence/orchestrator.ts']
      .map((f) => lire(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('\n');
    expect(src).not.toMatch(/PROPERTY_TAX|TAXE_FONCIERE|taxe fonci|Impôts et taxes/i);
  });
});

describe('L82B-U-COVERAGE — couverture explicite (CA-19)', () => {
  it('tous les domaines C-Q1 sont inventoriés ; un domaine sans contrôle actif déclare sa lacune ; chaque contrôle cité existe', () => {
    const domaines = COVERAGE_INVENTORY.map((e) => e.domain);
    for (const d of C_Q1_DOMAINS) expect(domaines, d).toContain(d);
    const actifs = new Set(activeChecks().map((c) => c.id));
    for (const e of COVERAGE_INVENTORY) {
      for (const id of e.checks) expect(actifs.has(id), `${e.domain} → ${id}`).toBe(true);
      if (e.checks.length === 0) expect(e.gap, e.domain).toBeTruthy();
    }
    // Chaque contrôle actif couvre au moins un domaine inventorié.
    for (const id of actifs) expect(COVERAGE_INVENTORY.some((e) => e.checks.includes(id)), id).toBe(true);
  });
});

describe('L82B-U-ENGINE — décisions pures du moteur (C-Q2, C-Q4)', () => {
  const prev = (o: Partial<ProofState>): ProofState => ({
    last_result: null, last_repair_hash: null, repair_attempts: 0, finding_streak: 0, consecutive_errors: 0, first_detected_at: null, ...o,
  });

  it('L82B-U-ENGINE-01 — verdict → résultat : à blanc, un diagnostic réparable n’est jamais réparé (WOULD_REPAIR)', () => {
    expect(resultOfVerdict({ verdict: 'REPAIRABLE' }, 'DRY_RUN', true)).toBe('WOULD_REPAIR');
    expect(resultOfVerdict({ verdict: 'REPAIRABLE' }, 'CORRECTIVE', true)).toBe('TRY_REPAIR');
    expect(resultOfVerdict({ verdict: 'REPAIRABLE' }, 'CORRECTIVE', false)).toBe('FINDING');
    expect(resultOfVerdict({ verdict: 'AMBIGUOUS' }, 'CORRECTIVE', true)).toBe('AMBIGUOUS');
    expect(resultOfVerdict({ verdict: 'FINDING' }, 'CORRECTIVE', true)).toBe('FINDING');
    expect(resultOfVerdict({ verdict: 'CONSISTENT' }, 'CORRECTIVE', true)).toBe('CONSISTENT');
  });

  it('L82B-U-ENGINE-02 — anti-boucle : mêmes entrées après une réparation inefficace → jamais rejouée ; entrées changées → permise', () => {
    expect(repairAllowed(undefined, 'h1')).toBe(true);
    expect(repairAllowed(prev({ last_result: 'REPAIR_INEFFECTIVE', last_repair_hash: 'h1' }), 'h1')).toBe(false);
    expect(repairAllowed(prev({ last_result: 'REPAIR_SUPPRESSED', last_repair_hash: 'h1' }), 'h1')).toBe(false);
    expect(repairAllowed(prev({ last_result: 'REPAIR_INEFFECTIVE', last_repair_hash: 'h1' }), 'h2')).toBe(true);
    // Échec technique : reprise bornée.
    expect(repairAllowed(prev({ last_result: 'REPAIR_FAILED', last_repair_hash: 'h1', repair_attempts: MAX_REPAIR_RETRIES - 1 }), 'h1')).toBe(true);
    expect(repairAllowed(prev({ last_result: 'REPAIR_FAILED', last_repair_hash: 'h1', repair_attempts: MAX_REPAIR_RETRIES }), 'h1')).toBe(false);
  });

  it('L82B-U-ENGINE-03 — preuve : une erreur n’est jamais un succès ni une remise à zéro ; un constat persistant compte sa série', () => {
    const t = new Date('2026-10-23T08:00:00Z');
    const d0 = new Date('2026-10-20T08:00:00Z');
    expect(nextProofCounters(prev({ finding_streak: 2, first_detected_at: d0 }), 'ERROR', t)).toEqual({ findingStreak: 2, consecutiveErrors: 1, firstDetectedAt: d0 });
    expect(nextProofCounters(prev({ finding_streak: 2, first_detected_at: d0 }), 'FINDING', t)).toEqual({ findingStreak: 3, consecutiveErrors: 0, firstDetectedAt: d0 });
    expect(nextProofCounters(undefined, 'WOULD_REPAIR', t)).toEqual({ findingStreak: 1, consecutiveErrors: 0, firstDetectedAt: t });
    expect(nextProofCounters(prev({ finding_streak: 5, consecutive_errors: 3, first_detected_at: d0 }), 'REPAIRED', t)).toEqual({ findingStreak: 0, consecutiveErrors: 0, firstDetectedAt: null });
  });
});

describe('L82B-U-MODE — mode à blanc par défaut (C-Q5), échéance quotidienne', () => {
  it('à blanc sauf demande explicite ; valeur inconnue → à blanc', () => {
    expect(coherenceMode({})).toBe('DRY_RUN');
    expect(coherenceMode({ COHERENCE_CAMPAIGN_MODE: 'corrective' })).toBe('CORRECTIVE');
    expect(coherenceMode({ COHERENCE_CAMPAIGN_MODE: 'Correctif' })).toBe('CORRECTIVE');
    expect(coherenceMode({ COHERENCE_CAMPAIGN_MODE: 'corectif' })).toBe('DRY_RUN');
    expect(coherenceMode({ COHERENCE_CAMPAIGN_MODE: 'dry-run' })).toBe('DRY_RUN');
  });

  it('échéance d’une campagne quotidienne : lendemain 5 h, heure de Paris (heure d’été et d’hiver)', () => {
    expect(dailyDeadline(new Date('2026-10-23T10:00:00Z')).toISOString()).toBe('2026-10-24T03:00:00.000Z');
    expect(dailyDeadline(new Date('2026-12-10T10:00:00Z')).toISOString()).toBe('2026-12-11T04:00:00.000Z');
  });

  it('empreintes de Supervision : une par contrôle et par nature (domaine « Autres traitements techniques »)', () => {
    expect(fingerprintOf('COH-DOC-LINKS', 'persistent')).toBe('other:coherence:coh-doc-links:persistent');
  });
});

describe('L82B-U-C-Q9 — ancienne maintenance réellement retirée (une seule chaîne)', () => {
  const RETIRES = [
    'src/services/coherence/coherence-maintenance.service.ts', 'src/services/coherence/nightly-catchup.service.ts',
    'src/services/coherence/version-tracker.service.ts', 'src/services/coherence/impact-propagation.service.ts',
    'src/services/coherence/impact-queue.service.ts', 'src/services/coherence/field-dependency.service.ts',
    'src/services/coherence/inconsistency.service.ts',
  ];

  it('L82B-U-C-Q9-01 — modules retirés absents, plus aucun import ni appel (markVerified, runNightlyCatchup, file impact_queue)', () => {
    for (const f of RETIRES) expect(existsSync(join(ROOT, f)), f).toBe(false);
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p);
      }
      return out;
    };
    const fautes: string[] = [];
    for (const f of walk(join(ROOT, 'src'))) {
      const rel = relative(ROOT, f);
      if (rel.endsWith('l82b-registre-socle.test.ts')) continue;
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/['"`](?:@\/services\/coherence|\.\.?)\/(coherence-maintenance|nightly-catchup|version-tracker|impact-propagation|impact-queue|field-dependency|inconsistency)(\.service)?['"`]/.test(src)) fautes.push(`${rel} : import`);
      if (/\b(markVerified|runNightlyCatchup|runCoherenceMaintenance|processPendingImpacts|emitAgendaItemCreated|runAutomaticAgendaDuplicatesReprise)\s*\(/.test(src)) fautes.push(`${rel} : appel`);
    }
    expect(fautes).toEqual([]);
  });

  it('L82B-U-C-Q9-02 — tâches remplacées retirées ; une seule tâche de cohérence au catalogue', async () => {
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const codes = SCHEDULED_TASKS.map((t) => t.code);
    expect(codes).toContain('coherence-control');
    expect(codes).not.toContain('agenda-intervention-duplicates-reprise');
    const { dailyTasks } = await import('@/services/scheduling/daily-maintenance-scheduler');
    expect(dailyTasks({} as NodeJS.ProcessEnv).map((t) => t.lock)).not.toContain('hourly-coherence-maintenance');
    const t = SCHEDULED_TASKS.find((x) => x.code === 'coherence-control')!;
    expect(t.schedule).toEqual({ kind: 'interval', everyMs: 15 * 60_000, window: { from: [5, 0], to: [24, 0] } });
    expect(t.critical).toBeUndefined();
  });

  it('L82B-U-C-Q9-03 — plus aucune écriture du statut utilisateur « annulé » ni détachement silencieux par une maintenance', () => {
    const src = lire('src/services/coherence/registry/checks/agenda.ts') + lire('src/services/coherence/registry/checks/document-links.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/manual_status\s*=\s*'annule'|manualStatus:\s*'annule'/);
    expect(code).not.toMatch(/UPDATE\s+asset_files\s+SET\s+asset_id\s*=\s*NULL/i);
    expect(code).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO)\b/);
  });
});

describe('Lot 38 O0 (C18) — aucune propagation générique vers l’acquisition, la valorisation ou l’agenda (moteur retiré au lot 82B)', () => {
  // Les cas F-163 à F-165 étaient vérifiés sur l'ancien moteur `impact-propagation` (règles `field_dependencies`).
  // Ce moteur est RETIRÉ (C-Q9) : la garantie devient structurelle — plus aucun code ne lit ces règles ni ne propage.
  const code = (rel: string) => lire(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const sources = () => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) { if (e !== '__tests__') walk(p); } else if (/\.(ts|tsx)$/.test(e) && !/\.test\.|\.e2e\./.test(e)) out.push(relative(ROOT, p));
      }
    };
    walk(join(ROOT, 'src'));
    // schema.ts déclare la table ; le catalogue d'export (82E) la classe : ni l'un ni l'autre ne lit les règles.
    // Catalogues d'export (82E) et registre de couverture du diagnostic global (88A) : noms de tables seuls, aucune lecture de règle.
    return out.filter((f) => f !== 'src/db/schema.ts' && f !== 'src/services/admin/diagnostics-export/recette-catalog.ts' && f !== 'src/services/admin/diagnostics-export/coverage.ts');
  };

  it('F-163 / F-164 — date ou montant documentaire générique : plus aucun lecteur des règles `field_dependencies`, aucune propagation vers acquisitionDate / acquisitionPrice / estimatedValue', () => {
    const lecteurs = sources().filter((f) => /\bfieldDependencies\b|field_dependencies/.test(code(f)));
    expect(lecteurs).toEqual([]);
    // La migration 0315 (neutralisation des anciennes règles) reste en place.
    expect(existsSync(join(ROOT, 'src/db/migrations/0315_neutralize_generic_propagations.sql'))).toBe(true);
  });

  it('F-165 — « prochaine échéance » : aucun moteur générique ne crée d’événement d’agenda (T4 et la projection des Opérations seuls)', () => {
    const fautifs = sources().filter((f) => /agenda_creation|impactQueue|impact_queue.*INSERT|INSERT INTO impact_queue/.test(code(f)));
    expect(fautifs.filter((f) => !f.startsWith('src/services/assets/') && !f.includes('AgendaWriteService') && !f.includes('undo.service'))).toEqual([]);
  });
});
