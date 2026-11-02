/**
 * Diagnostic du compte technique de qualification — lot 103G (point D).
 *
 * MÊME diagnostic, en LECTURE SEULE, pour :
 *   · BO › Configuration IA › Compte technique de qualification ;
 *   · la route `GET /api/cron/ai/corpus-account` (CRON_SECRET) ;
 *   · le diagnostic global autosuffisant (`ia/compte-technique-qualification.json`).
 *
 * Contenu : identité technique NON sensible (identifiants, marqueur, contrôles
 * passés / échoués — jamais d'adresse e-mail client, de hachage ni de secret),
 * variable `CORPUS_ACCOUNT_ID` déclarée / lisible / cohérente, motif
 * CORPUS_ACCOUNT_*, prochain geste, incompatibilités de prompts en attente du
 * prérequis, campagnes refusées ou bloquées pour cette cause, cas du corpus
 * concernés, reprises automatiques effectuées.
 */
import {
  assessCorpusAccount, autoProvisionAllowed, corpusAnomalyInputs, corpusAnomalyReportable, readCorpusAccountSnapshot,
  CORPUS_ACCOUNT_FINGERPRINT, CORPUS_ACCOUNT_SECURITY_FINGERPRINT, type CorpusAccountStatus, type CorpusQuery,
} from './technical-account';

type Row = Record<string, unknown>;

export interface CorpusAccountDiagnostic {
  readAt: string;
  environment: string;
  status: CorpusAccountStatus;
  autoProvision: { allowed: boolean; variable: string };
  /** Incompatibilités de prompts en attente / bloquées par le prérequis. */
  conformity: Array<{ issueId: number; contractId: string; treatment: string; status: string; code: string | null; since: string | null; resumes: number }>;
  /** Campagnes refusées au précontrôle ou bloquées en exécution pour cette cause (dernières). */
  campaigns: Array<{ id: number; kind: string; status: string; code: string | null; stage: string | null; cases: string[]; at: string | null }>;
  /** Reprises automatiques après réparation (dernières). */
  resumes: Array<{ issueId: number; contractId: string; at: string; message: string }>;
  /** Cas du corpus non exécutés pour cette cause (dernières campagnes). */
  blockedCases: string[];
}

const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

async function safe(query: CorpusQuery, text: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return await query(text, params);
  } catch {
    return []; // table absente (avant migration) : section vide, jamais d'erreur d'écran
  }
}

export async function corpusAccountDiagnostic(opts: { query?: CorpusQuery; environment?: string } = {}): Promise<CorpusAccountDiagnostic> {
  const query: CorpusQuery = opts.query ?? (async (t, p) => {
    const { pgClient } = await import('@/db');
    return (await pgClient.unsafe(t, p as never[])) as unknown as Row[];
  });
  const environment = opts.environment ?? (await import('../config/environment')).getAiEnvironment();
  const status = assessCorpusAccount(await readCorpusAccountSnapshot({ query }));
  const issues = await safe(query,
    `SELECT id, contract_id, treatment, status, prerequisite, qualification FROM ai_prompt_conformity_issues
      WHERE environment = $1 AND status NOT IN ('RESOLVED', 'ACTIVATED') ORDER BY id`, [environment]);
  const { currentPrerequisite } = await import('../prompt-conformity/prerequisite');
  const conformity = issues.flatMap((r) => {
    const p = currentPrerequisite({ status: String(r.status), prerequisite: (r.prerequisite ?? {}) as Record<string, unknown>, qualification: (r.qualification ?? {}) as Record<string, unknown> });
    return p ? [{ issueId: Number(r.id), contractId: String(r.contract_id), treatment: String(r.treatment), status: String(r.status), code: p.code ?? null, since: p.since ?? null, resumes: p.resumes ?? 0 }] : [];
  });
  const camps = await safe(query,
    `SELECT id, kind, status, summary, COALESCE(finished_at, created_at) AS at FROM ai_qualification_campaigns
      WHERE environment = $1 AND summary ? 'prerequisite' ORDER BY id DESC LIMIT 20`, [environment]);
  const campaigns = camps.map((r) => {
    const p = ((r.summary ?? {}) as { prerequisite?: { code?: string; stage?: string; cases?: string[] } }).prerequisite ?? {};
    return { id: Number(r.id), kind: String(r.kind), status: String(r.status), code: p.code ?? null, stage: p.stage ?? null, cases: (p.cases ?? []).slice(0, 50), at: iso(r.at) };
  });
  const ev = await safe(query,
    `SELECT issue_id, contract_id, created_at, message FROM ai_prompt_conformity_events
      WHERE environment = $1 AND kind = 'PREREQUISITE_RESUMED' ORDER BY id DESC LIMIT 20`, [environment]);
  return {
    readAt: new Date().toISOString(), environment, status,
    autoProvision: { allowed: autoProvisionAllowed(environment), variable: 'AI_CORPUS_ACCOUNT_AUTO_PROVISION' },
    conformity, campaigns,
    resumes: ev.map((r) => ({ issueId: Number(r.issue_id), contractId: String(r.contract_id), at: iso(r.created_at)!, message: String(r.message).slice(0, 300) })),
    blockedCases: [...new Set(campaigns.flatMap((c) => c.cases))].slice(0, 100),
  };
}

/**
 * Conditions de Supervision (pures) : UNE anomalie regroupée pour le compte technique (et une de sécurité si la
 * variable désigne un compte client), quelle que soit la quantité d'incompatibilités ou de campagnes affectées.
 * Instant d'occurrence STABLE (début du blocage le plus récent) : un balayage répété ne recompte pas.
 */
export function corpusAccountConditions(d: CorpusAccountDiagnostic): Array<{ fingerprint: string; occurredAt: Date; input: { domain: 'ai'; fingerprint: string; title: string; accountId?: number | null; detail: Record<string, unknown> } }> {
  if (!corpusAnomalyReportable(d.status, d.environment)) return [];
  const instants = [...d.conformity.map((c) => c.since), ...d.campaigns.map((c) => c.at)].filter((x): x is string => Boolean(x)).map((x) => Date.parse(x));
  const occurredAt = new Date(instants.length ? Math.max(...instants) : 0);
  const impact = { conformity: d.conformity.map((c) => c.contractId).slice(0, 30), campaigns: d.campaigns.map((c) => c.id).slice(0, 20), cases: d.blockedCases.slice(0, 30) };
  const inputs = corpusAnomalyInputs(d.status, impact);
  const out: ReturnType<typeof corpusAccountConditions> = [{
    fingerprint: CORPUS_ACCOUNT_FINGERPRINT, occurredAt,
    input: { domain: 'ai', fingerprint: CORPUS_ACCOUNT_FINGERPRINT, title: inputs.prerequisite.title, detail: inputs.prerequisite.detail },
  }];
  if (inputs.security) {
    out.push({
      fingerprint: CORPUS_ACCOUNT_SECURITY_FINGERPRINT, occurredAt,
      input: { domain: 'ai', fingerprint: CORPUS_ACCOUNT_SECURITY_FINGERPRINT, accountId: d.status.variable.value, title: inputs.security.title, detail: inputs.security.detail },
    });
  }
  return out;
}
