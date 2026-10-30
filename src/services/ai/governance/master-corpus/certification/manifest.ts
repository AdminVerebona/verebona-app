/**
 * Lot 100B — MANIFESTE VERSIONNÉ du corpus de qualification (ticket #601,
 * partie 1/5) : une entrée par cas, identifiant IMMUABLE, historique des
 * révisions, registre des identifiants publiés.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES (contrôlées par `validateManifest`, en CI)
 *
 *   · identifiants uniques, jamais supprimés (registre `ledger`) : un cas
 *     retiré reste au manifeste avec le statut HISTORIQUE ou REJETÉE et son
 *     motif — aucune suppression silencieuse ;
 *   · aucun statut RÉFÉRENCE_APPROUVÉE déclaré : il est CALCULÉ depuis
 *     l'approbation individuelle tracée (`effectiveStatus`) ;
 *   · toute modification d'un oracle passe par une RÉVISION (empreinte de
 *     l'oracle portée par la dernière révision) : un oracle modifié sans
 *     révision fait échouer la CI ; un oracle modifié n'est plus approuvé
 *     (l'approbation porte sur l'empreinte) et invalide les qualifications
 *     qui l'utilisaient (empreinte du corpus dans la signature 86A) ;
 *   · chaque fixture du corpus a son entrée ; chaque entrée exécutable
 *     désigne une fixture existante ; l'attendu serveur de l'oracle est
 *     celui de la fixture (une seule vérité).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../../../qualification/signature';
import { corpusManifest, type CaseStatus, type CorpusManifest, type ManifestEntry } from './model';
import { oracleApprovalProblems, oracleFingerprint } from './oracle';

/** Racine du dépôt (même repli que `cases.ts` sous le serveur Next). */
function repoRoot(): string {
  const parSource = join(__dirname, '..', '..', '..', '..', '..', '..');
  return existsSync(join(parSource, 'src', 'services', 'ai', 'governance', 'master-corpus', 'certification')) ? parSource : process.cwd();
}
export const REPO_ROOT = repoRoot();
export const MANIFEST_PATH = join(REPO_ROOT, 'src', 'services', 'ai', 'governance', 'master-corpus', 'certification', 'corpus-manifest.json');

let cache: { path: string; manifest: CorpusManifest } | null = null;
let override: CorpusManifest | null = null;

/** Tests : manifeste substitué (null : fichier du dépôt). */
export function __setCorpusManifestForTests(m: CorpusManifest | null): void { override = m; cache = null; }

/** Manifeste en vigueur (fichier du dépôt, validé par le schéma). Absent : manifeste vide (jamais d'approbation implicite). */
export function loadCorpusManifest(path = MANIFEST_PATH): CorpusManifest {
  if (override) return override;
  if (cache?.path === path) return cache.manifest;
  const manifest = existsSync(path)
    ? corpusManifest.parse(JSON.parse(readFileSync(path, 'utf8')))
    : { version: 1, generatedAt: new Date(0).toISOString(), reference: { ticket: '#601', announcedScenarios: 401, announcedStress: 15, zipReceived: false }, entries: [], ledger: [] };
  cache = { path, manifest };
  return manifest;
}

/** Entrée du manifeste d'une fixture (fichier relatif au dépôt + identifiant `case`). */
export function entryForFixture(m: CorpusManifest, file: string, caseId: string): ManifestEntry | null {
  const f = file.replace(/\\/g, '/');
  return m.entries.find((e) => e.file === f && (e.sourceCaseId ?? e.id) === caseId) ?? m.entries.find((e) => e.file === f) ?? null;
}

// ── Statut effectif ────────────────────────────────────────────────────────

export interface ApprovalRef {
  caseId: string;
  oracleFingerprint: string;
  decision: 'APPROVED' | 'REVOKED';
  at: string;
  by: string;
}

export interface StatusDecisionRef { caseId: string; status: 'REJETEE' | 'RETABLIE'; reason: string; at: string; by: string }

export interface EffectiveStatus { status: CaseStatus; reason: string; approval: ApprovalRef | null; staleApproval: ApprovalRef | null }

/**
 * Statut EFFECTIF d'une entrée (pur) : RÉFÉRENCE_APPROUVÉE seulement si une
 * approbation humaine non révoquée porte sur l'empreinte EXACTE de l'oracle
 * courant, pour un cas à compléter évalué par oracle ; une décision de rejet
 * du BO prime (REJETÉE, motif conservé, jamais supprimé).
 */
export function effectiveStatus(e: ManifestEntry, approvals: readonly ApprovalRef[], decisions: readonly StatusDecisionRef[] = []): EffectiveStatus {
  const dec = [...decisions].filter((d) => d.caseId === e.id).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (dec?.status === 'REJETEE') return { status: 'REJETEE', reason: `rejetée au BO par ${dec.by} : ${dec.reason}`, approval: null, staleApproval: null };
  const fp = oracleFingerprint(e.oracle);
  const mine = [...approvals].filter((a) => a.caseId === e.id).sort((a, b) => b.at.localeCompare(a.at));
  const courante = fp ? mine.find((a) => a.oracleFingerprint === fp) : undefined;
  const ancienne = mine.find((a) => a.decision === 'APPROVED' && a.oracleFingerprint !== fp) ?? null;
  if (e.status === 'A_COMPLETER' && e.evaluationType === 'ORACLE' && courante?.decision === 'APPROVED' && !oracleApprovalProblems(e.oracle).length) {
    return { status: 'REFERENCE_APPROUVEE', reason: `oracle v${e.oracle!.version} approuvé par ${courante.by} le ${courante.at.slice(0, 10)}`, approval: courante, staleApproval: null };
  }
  if (e.status === 'A_COMPLETER' && ancienne && (!courante || courante.decision !== 'APPROVED')) {
    return { status: 'A_COMPLETER', reason: `oracle modifié depuis l’approbation du ${ancienne.at.slice(0, 10)} : nouvelle approbation requise — ${e.reason}`, approval: null, staleApproval: ancienne };
  }
  return { status: e.status, reason: e.reason, approval: null, staleApproval: null };
}

/**
 * Empreinte de CERTIFICATION d'une opération : oracles (contenu) et
 * approbations courantes de ses cas. Entre dans l'empreinte du corpus de la
 * signature 86A : modifier un oracle, l'approuver ou révoquer son approbation
 * rend OBSOLÈTES les qualifications antérieures de l'opération (recette 8).
 */
export function certificationFingerprint(m: CorpusManifest, operationCode: string, approvals: readonly ApprovalRef[], decisions: readonly StatusDecisionRef[] = []): string {
  const l = m.entries.filter((e) => e.operationCode === operationCode).map((e) => ({
    id: e.id, oracle: oracleFingerprint(e.oracle), status: effectiveStatus(e, approvals, decisions).status, critical: e.critical, pair: e.pair,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return sha256(canonicalJson(l));
}

// ── Validation ─────────────────────────────────────────────────────────────

export interface FixtureOnDisk { file: string; caseId: string; expected: Record<string, unknown> | null; role: string | null }

/** Problèmes du manifeste (vide : conforme). `fixtures` : cas présents sur disque. */
export function validateManifest(m: CorpusManifest, fixtures: readonly FixtureOnDisk[] | null = null, previous: CorpusManifest | null = null): string[] {
  const p: string[] = [];
  const ids = m.entries.map((e) => e.id);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) p.push(`identifiant dupliqué au manifeste : ${id}`);
  for (const id of m.ledger) if (!ids.includes(id)) p.push(`identifiant ${id} publié puis disparu du manifeste (suppression silencieuse interdite : passer en HISTORIQUE ou REJETÉE)`);
  for (const id of ids) if (!m.ledger.includes(id)) p.push(`identifiant ${id} absent du registre des identifiants publiés`);
  if (previous) {
    if (m.version < previous.version) p.push(`version du manifeste ${m.version} < version précédente ${previous.version}`);
    for (const id of previous.ledger) if (!m.ledger.includes(id)) p.push(`identifiant ${id} retiré du registre (interdit)`);
  }
  for (const e of m.entries) {
    const revs = e.revisions;
    for (let i = 1; i < revs.length; i += 1) if (revs[i].revision !== revs[i - 1].revision + 1) p.push(`${e.id} : révisions non consécutives`);
    const last = revs[revs.length - 1];
    const fp = oracleFingerprint(e.oracle);
    if ((last.oracleFingerprint ?? null) !== fp) p.push(`${e.id} : oracle modifié sans révision (empreinte ${fp?.slice(0, 12) ?? 'aucune'} ≠ révision ${last.revision} ${last.oracleFingerprint?.slice(0, 12) ?? 'aucune'})`);
    if (e.evaluationType === 'ORACLE' && e.status === 'GARDE_SERVEUR') p.push(`${e.id} : une garde serveur n’est jamais évaluée par oracle`);
    if (e.status === 'GARDE_SERVEUR' && e.testType !== 'GARDE_SERVEUR') p.push(`${e.id} : garde serveur hors type de test GARDE_SERVEUR (jamais une référence de promotion)`);
    if (e.status === 'GARDE_SERVEUR' && e.critical) p.push(`${e.id} : une garde serveur ne peut pas être un cas critique de promotion`);
    if (e.pair && !e.operationCode) p.push(`${e.id} : paire sans opération`);
    if (e.inputMode === 'FILE' && e.status === 'A_COMPLETER' && !e.sourcePieces.length) p.push(`${e.id} : cas multimodal sans fichier source (non rejouable, à classer HISTORIQUE)`);
    if (e.file && fixtures && !fixtures.some((f) => f.file === e.file)) p.push(`${e.id} : fixture ${e.file} introuvable`);
    if (e.file && fixtures && e.oracle?.serverExpected) {
      const f = fixtures.find((x) => x.file === e.file);
      if (f && canonicalJson(f.expected ?? {}) !== canonicalJson(e.oracle.serverExpected)) p.push(`${e.id} : attendu de la fixture ≠ attendu serveur de l’oracle (une seule vérité)`);
    }
  }
  if (fixtures) {
    for (const f of fixtures) if (!m.entries.some((e) => e.file === f.file)) p.push(`fixture ${f.file} (${f.caseId}) sans entrée au manifeste`);
    const parId = new Map<string, string[]>();
    for (const f of fixtures) parId.set(f.caseId, [...(parId.get(f.caseId) ?? []), f.file]);
    for (const [id, files] of parId) if (files.length > 1) p.push(`identifiant de cas ${id} porté par plusieurs fixtures (${files.join(', ')})`);
  }
  return p;
}

/** Nouvelle révision d'une entrée (pure) : l'historique est conservé, l'empreinte de l'oracle tracée. */
export function reviseEntry(e: ManifestEntry, patch: Partial<Omit<ManifestEntry, 'id' | 'revisions'>>, by: string, reason: string, at = new Date().toISOString()): ManifestEntry {
  const next = { ...e, ...patch } as ManifestEntry;
  const changes = Object.keys(patch).filter((k) => canonicalJson((e as Record<string, unknown>)[k]) !== canonicalJson((patch as Record<string, unknown>)[k]));
  if (!changes.length) return e;
  return {
    ...next,
    revisions: [...e.revisions, { revision: e.revisions.length + 1, at, by, reason, changes, oracleFingerprint: oracleFingerprint(next.oracle) }],
  };
}
