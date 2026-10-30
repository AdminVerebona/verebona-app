/**
 * Lot 100B — construction / mise à jour du manifeste depuis les fixtures du
 * dépôt (outil de développeur : `npm run ai:corpus:manifest`).
 *
 * Une entrée EXISTANTE n'est jamais régénérée ni supprimée (son historique
 * fait foi ; une évolution passe par `reviseEntry`). Seules les fixtures
 * sans entrée sont ajoutées (classement `historical.ts`) ; le registre des
 * identifiants publiés ne fait que croître.
 */
import { loadMasterCorpusCases, readMasterFileFromRepo, type MasterCorpusCase } from '../cases';
import { historicalEntry, t1ReferenceEntry } from './historical';
import type { FixtureOnDisk } from './manifest';
import type { CorpusManifest, ManifestEntry } from './model';

export interface RepoCorpus { cases: MasterCorpusCase[]; replayable: Map<string, boolean> }

/** Cas du dépôt et leur rejouabilité (constructeurs de production). */
export async function readRepoCorpus(): Promise<RepoCorpus> {
  const { liveVariablesFor } = await import('../live');
  const cases = loadMasterCorpusCases(readMasterFileFromRepo);
  const replayable = new Map<string, boolean>();
  for (const c of cases) replayable.set(c.file, Boolean(await liveVariablesFor(c).catch(() => null)));
  return { cases, replayable };
}

/** Fixtures sur disque (validation du manifeste). */
export function fixturesOnDisk(cases: readonly MasterCorpusCase[]): FixtureOnDisk[] {
  return cases.map((c) => ({ file: c.file.replace(/\\/g, '/'), caseId: c.id, expected: c.expected, role: c.qualificationRole ?? null }));
}

/** Manifeste mis à jour (pur à partir du corpus lu) : ajouts seulement. */
export async function updateManifest(existing: CorpusManifest | null, corpus: RepoCorpus, at = new Date().toISOString()): Promise<{ manifest: CorpusManifest; added: string[] }> {
  const { CORPUS_CASES } = await import('../../corpus/corpus-cases');
  const entries: ManifestEntry[] = [...(existing?.entries ?? [])];
  const added: string[] = [];
  const ids = new Set(corpus.cases.map((c) => c.id));
  for (const c of corpus.cases) {
    const file = c.file.replace(/\\/g, '/');
    if (entries.some((e) => e.file === file)) continue;
    const duplicates = corpus.cases.filter((x) => x.id === c.id && x.file !== c.file).map((x) => x.file);
    const e = historicalEntry(c, { replayable: corpus.replayable.get(c.file) ?? false, duplicates, allCaseIds: ids }, at);
    entries.push(e);
    added.push(e.id);
  }
  for (const r of CORPUS_CASES) {
    const e = t1ReferenceEntry(r as never, at);
    if (entries.some((x) => x.id === e.id)) continue;
    entries.push(e);
    added.push(e.id);
  }
  const ledger = [...new Set([...(existing?.ledger ?? []), ...entries.map((e) => e.id)])];
  const manifest: CorpusManifest = {
    version: (existing?.version ?? 0) + (added.length || !existing ? 1 : 0),
    generatedAt: added.length || !existing ? at : existing.generatedAt,
    reference: existing?.reference ?? { ticket: '#601', announcedScenarios: 401, announcedStress: 15, zipReceived: false },
    entries, ledger,
  };
  return { manifest, added };
}
