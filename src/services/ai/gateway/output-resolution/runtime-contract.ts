/**
 * CONTRAT RUNTIME — source unique de vérité d'un appel structuré, lot 34D
 * (ticket « faire du contrat runtime la source unique de vérité pour
 * génération, validation, réparation et fallback »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *                     CONTRAT RUNTIME CANONIQUE (résolu AVANT l'appel, figé)
 *                                  │
 *         ┌──────────────┬─────────┼──────────────┬──────────────┐
 *         ▼              ▼         ▼              ▼              ▼
 *   schéma fournisseur  bloc de   validation   passe de      fallbacks
 *   (structured output) priorité  + normali-   réparation    (même contrat,
 *   DÉRIVÉ du contrat   du prompt sation       (contrat      seul l'adapta-
 *                                              exact)        teur varie)
 *
 * Avant l'appel, la passerelle résout le contrat applicable — identifiant,
 * version, version et empreinte du schéma — puis le FIGE (`Object.freeze`)
 * pour toute l'exécution : modèle principal, réparations et replis
 * l'utilisent, même si une autre version devient active entre-temps (RTC-04).
 *
 * Il n'existe qu'UNE définition par contrat : le schéma Zod du registre
 * (`master-output-schemas` + versions de `contracts.ts`). Le schéma JSON du
 * fournisseur, le schéma de la passe de réparation et le schéma inclus dans
 * le prompt (fournisseur sans structured output) en sont DÉRIVÉS.
 *
 * Un schéma de validation différent du schéma transmis au modèle (empreintes
 * différentes) est un défaut interne du moteur : `RUNTIME_CONTRACT_MISMATCH`,
 * diagnostiqué au BO, jamais montré à l'utilisateur (RTC-07).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { z, type ZodType } from 'zod';
import { MASTER_OUTPUT_SCHEMAS } from '../master-output-schemas';
import { T1AnalyzeDocumentTolerantOutput } from '../../source-analysis/master/tolerant-output';
import { listContracts, schemaHash } from './contracts';
import { splitPipe } from './field-validation';
import { COMPAT_TABLE_VERSION } from './compat-mappings';

/** Contrat runtime d'une exécution. Immuable une fois résolu. */
export interface RuntimeContract {
  /** `T1_ANALYZE_DOCUMENT` (registre) ou code d'opération (contrat de l'appelant). */
  readonly contractId: string;
  readonly contractVersion: number;
  /** Nom du schéma au registre (`T1AnalyzeDocumentOutput`), `null` hors registre. */
  readonly schemaName: string | null;
  /** `t1_analyze_document@v3`. */
  readonly schemaVersion: string;
  /** Empreinte (12) du schéma JSON canonique dérivé. */
  readonly schemaHash: string;
  /** Schéma de VALIDATION (préparation déclarée + schéma canonique). */
  readonly schema: ZodType;
  /** Schéma canonique (sans préparation) : source de toutes les dérivations. */
  readonly canonical: ZodType;
  readonly compatTableVersion: number;
  /** `registry` : contrat du registre ; `caller` : contrat de l'appelant (opération hors registre). */
  readonly source: 'registry' | 'caller';
}

/** Ce qui identifie un contrat dans les traces (génération / validation). */
export interface ContractStamp {
  contractId: string;
  contractVersion: number;
  schemaVersion: string;
  schemaHash: string;
}

export function contractStamp(c: RuntimeContract): ContractStamp {
  return { contractId: c.contractId, contractVersion: c.contractVersion, schemaVersion: c.schemaVersion, schemaHash: c.schemaHash };
}

/** Désaccord constaté entre le schéma de génération et celui de validation. */
export interface ContractMismatch {
  generation: ContractStamp;
  validation: ContractStamp;
  message: string;
}

/** Écart entre deux tampons (même contrat ⇔ même identifiant, version et empreinte). */
export function compareStamps(generation: ContractStamp, validation: ContractStamp): ContractMismatch | null {
  if (generation.contractId === validation.contractId && generation.contractVersion === validation.contractVersion
    && generation.schemaHash === validation.schemaHash) return null;
  return {
    generation, validation,
    message: `RUNTIME_CONTRACT_MISMATCH : schéma transmis ${generation.schemaVersion} (${generation.schemaHash}) ≠ `
      + `schéma de validation ${validation.schemaVersion} (${validation.schemaHash})`,
  };
}

// ── Registre des versions ────────────────────────────────────────────────────

interface Entry {
  schemaName: string;
  contractId: string;
  label: string;
  version: number;
  /** Schéma CANONIQUE (registre) : source de l'empreinte et de toutes les dérivations. */
  canonical: ZodType;
  /** Schéma de validation (préparation déclarée comprise ; sinon le canonique). */
  schema: ZodType;
}

/**
 * Préparation DÉCLARÉE par contrat (lecture tolérante T1, lot 12) : elle fait
 * partie du contrat — la validation l'applique quel que soit le schéma de
 * l'appelant. Le schéma canonique reste celui du registre.
 */
const PREPARATIONS: Readonly<Record<string, ZodType>> = {
  T1AnalyzeDocumentOutput: T1AnalyzeDocumentTolerantOutput,
};

const versions = new Map<string, Map<number, Entry>>();
const activeOverride = new Map<string, number>();
const testContracts = new WeakSet<object>();

function idOf(label: string): string {
  return label.toUpperCase();
}

function register(e: Entry): void {
  const m = versions.get(e.schemaName) ?? new Map<number, Entry>();
  m.set(e.version, e);
  versions.set(e.schemaName, m);
}

for (const c of listContracts()) {
  const canonical = MASTER_OUTPUT_SCHEMAS[c.name];
  if (canonical) {
    register({ schemaName: c.name, contractId: idOf(c.label), label: c.label, version: c.version, canonical, schema: PREPARATIONS[c.name] ?? canonical });
  }
}

/** Version ACTIVE d'un contrat : la plus récente du registre (sauf surcharge de test). */
export function activeContractVersion(schemaName: string): number | null {
  const m = versions.get(schemaName);
  if (!m || m.size === 0) return null;
  return activeOverride.get(schemaName) ?? Math.max(...m.keys());
}

/** Versions connues d'un contrat (croissantes). */
export function contractVersionsOf(schemaName: string): number[] {
  return [...(versions.get(schemaName)?.keys() ?? [])].sort((a, b) => a - b);
}

/** Réservé aux tests : enregistre une version de contrat. */
export function __registerContractVersionForTests(p: { schemaName: string; label: string; version: number; schema: ZodType }): void {
  register({ schemaName: p.schemaName, contractId: idOf(p.label), label: p.label, version: p.version, canonical: splitPipe(p.schema).main, schema: p.schema });
}

/** Réservé aux tests : version active d'un contrat (`null` : la plus récente). */
export function __setActiveContractVersionForTests(schemaName: string, version: number | null): void {
  if (version === null) activeOverride.delete(schemaName); else activeOverride.set(schemaName, version);
}

/** Réservé aux tests : retire une version enregistrée par un test. */
export function __unregisterContractVersionForTests(schemaName: string, version: number): void {
  versions.get(schemaName)?.delete(version);
}

/**
 * Réservé aux tests de la PASSERELLE : un schéma d'appelant marqué ainsi est
 * accepté comme contrat d'une opération du registre (les tests génériques
 * de la passerelle empruntent `t1_group_upload` avec leur propre schéma).
 * Jamais utilisé par le code applicatif.
 */
export function asTestContract<T extends ZodType>(schema: T): T {
  testContracts.add(schema);
  return schema;
}

// ── Résolution ───────────────────────────────────────────────────────────────

export class ContractResolutionError extends Error {
  constructor(readonly code: 'CONTRACT_VERSION_NOT_FOUND', message: string) {
    super(message);
    this.name = 'ContractResolutionError';
  }
}

export interface ResolveContractInput {
  /** Nom du schéma déclaré par l'opération (`outputSchema`), `null` sinon. */
  schemaName: string | null;
  operationCode: string;
  /** Schéma fourni par l'appelant (`outputSchema` de la requête). */
  callerSchema: ZodType;
  /** Version imposée par la configuration (T4 : contrat de sortie configuré). */
  requestedVersion?: number | null;
}

export interface ResolvedContract {
  contract: RuntimeContract;
  /** Schéma de l'appelant ≠ contrat du registre : RUNTIME_CONTRACT_MISMATCH. */
  mismatch: ContractMismatch | null;
}

function freeze(c: RuntimeContract): RuntimeContract {
  return Object.freeze({ ...c });
}

/** Contrat bâti sur le schéma de l'appelant (opération hors registre, ou schéma de test). */
function callerContract(input: ResolveContractInput, base?: { contractId: string; version: number; label: string; schemaName: string }): RuntimeContract {
  const canonical = splitPipe(input.callerSchema).main;
  const label = base?.label ?? input.operationCode;
  const version = base?.version ?? 1;
  return freeze({
    contractId: base?.contractId ?? idOf(input.operationCode), contractVersion: version,
    schemaName: base?.schemaName ?? null, schemaVersion: `${label}@v${version}`,
    schemaHash: schemaHash(canonical), schema: input.callerSchema, canonical,
    compatTableVersion: COMPAT_TABLE_VERSION, source: 'caller',
  });
}

/**
 * Résout le contrat runtime d'un appel — AVANT tout contact fournisseur.
 * Lève `ContractResolutionError` si la version demandée n'existe pas.
 */
export function resolveRuntimeContract(input: ResolveContractInput): ResolvedContract {
  const m = input.schemaName ? versions.get(input.schemaName) : undefined;
  if (!input.schemaName || !m || m.size === 0) return { contract: callerContract(input), mismatch: null };

  const version = input.requestedVersion ?? activeContractVersion(input.schemaName)!;
  const entry = m.get(version);
  if (!entry) {
    throw new ContractResolutionError('CONTRACT_VERSION_NOT_FOUND',
      `Contrat ${input.schemaName} v${version} introuvable (versions connues : ${contractVersionsOf(input.schemaName).join(', ') || 'aucune'}).`);
  }
  if (testContracts.has(input.callerSchema)) {
    return { contract: callerContract(input, { contractId: entry.contractId, version: entry.version, label: entry.label, schemaName: entry.schemaName }), mismatch: null };
  }
  const canonical = entry.canonical;
  const contract = freeze({
    contractId: entry.contractId, contractVersion: entry.version, schemaName: entry.schemaName,
    schemaVersion: `${entry.label}@v${entry.version}`, schemaHash: schemaHash(canonical),
    schema: entry.schema, canonical, compatTableVersion: COMPAT_TABLE_VERSION, source: 'registry',
  });
  // Le schéma de l'appelant doit être CE contrat — son schéma canonique, ou
  // sa préparation déclarée (lecture tolérante T1 : canonique + compteurs
  // internes `_normalisation`) : sinon la sortie serait validée avec un
  // autre schéma que celui transmis au modèle.
  const callerHash = schemaHash(splitPipe(input.callerSchema).main);
  const admis = new Set([contract.schemaHash, schemaHash(splitPipe(entry.schema).main)]);
  const mismatch = admis.has(callerHash) ? null : compareStamps(contractStamp(contract), {
    contractId: contract.contractId, contractVersion: contract.contractVersion,
    schemaVersion: `${input.operationCode}@appelant`, schemaHash: callerHash,
  });
  return { contract, mismatch };
}

// ── Dérivations ──────────────────────────────────────────────────────────────

const jsonCache = new WeakMap<object, string>();

/** Schéma JSON COMPLET du contrat (passe de réparation, prompt sans structured output). */
export function contractJsonSchemaText(c: RuntimeContract): string {
  const hit = jsonCache.get(c.canonical);
  if (hit) return hit;
  let txt: string;
  try {
    const json = z.toJSONSchema(c.canonical, { io: 'input', unrepresentable: 'any', reused: 'inline' }) as Record<string, unknown>;
    delete json.$schema;
    txt = JSON.stringify(json);
  } catch {
    txt = '{}';
  }
  jsonCache.set(c.canonical, txt);
  return txt;
}

/** Empreinte (12) d'un schéma fournisseur dérivé. */
export function providerSchemaHash(schema: Record<string, unknown> | null): string | null {
  return schema ? createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 12) : null;
}

/**
 * Consigne COMMUNE des prompts structurés (ticket, « Règle de priorité ») :
 * ajoutée par la passerelle à chaque appel structuré — le texte des prompts
 * administrés n'a pas à la contenir. Sans structured output (fournisseur ou
 * modèle qui ne le supporte pas, refus du schéma, coupure), le schéma JSON
 * DÉRIVÉ du contrat est joint : le prompt ne recopie jamais le schéma à la
 * main.
 */
export const RUNTIME_CONTRACT_PRIORITY_RULE = [
  'Le contrat structuré fourni avec cet appel est la source de vérité technique.',
  'En cas de contradiction entre le texte du prompt, un exemple, une ancienne convention ou une version antérieure, et le contrat runtime :',
  'LE CONTRAT RUNTIME EST PRIORITAIRE.',
].join('\n');

export function runtimeContractBlock(c: RuntimeContract, opts: { schemaInPrompt: boolean }): string {
  return [
    '', '', '---', 'CONTRAT RUNTIME (fourni par le serveur)',
    `Contrat : ${c.contractId} v${c.contractVersion} · schéma ${c.schemaVersion} · empreinte ${c.schemaHash}`,
    RUNTIME_CONTRACT_PRIORITY_RULE,
    ...(opts.schemaInPrompt
      ? ['Format exact de la réponse (JSON Schema dérivé du contrat) :', contractJsonSchemaText(c)]
      : ['Le format exact de la réponse (propriétés, types, champs obligatoires, valeurs nulles, énumérations) est imposé par le schéma structuré joint à l’appel.']),
  ].join('\n');
}
