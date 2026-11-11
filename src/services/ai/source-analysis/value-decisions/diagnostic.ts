/**
 * Lot 108K (ticket « Correctifs de conformité du lot 91D », §3) — ACTIVATION
 * RÉELLE et BILAN des décisions T1 sur les valeurs, pour le diagnostic BO
 * durable EXISTANT (lot 107G, `diagnostics-export/collect.ts` — aucun moteur
 * parallèle, aucune requête SQL à écrire par le PO).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   · `ia/t1-decisions-valeurs.json` — CONFIGURATION lue en direct : prompt
 *     T1 effectif (version BO active ou fichier du dépôt) et présence du
 *     marqueur `t1-value-decisions-v1`, interrupteur T1_VALUE_DECISIONS_ENABLED,
 *     migrations 0798 / 1090, budgets ; CONTRÔLES (attendu → constaté) ;
 *     COMPTEURS par compte : décisions par statut / validité / décision /
 *     motif de rejet, conformité des sorties T1 (présent / vide / absent /
 *     mal formé / tronqué, concordance de version prompt / run), constats
 *     COH-DOC-EXTRACT-CHAIN par anomalie et qualification, progression des
 *     réexamens, appels et coût IA des réexamens ; RATTRAPAGE simulé (même
 *     sélection que le rattrapage BO 18, en lecture seule) ; et, dans le
 *     diagnostic D'UN COMPTE, le BILAN PAR DOCUMENT ET PAR UNITÉ calculé par
 *     le contrôle lui-même (`inspectExtractChain`, détail complet) ;
 *   · `ia/t1-decisions-valeurs.txt` — même contenu en tableau lisible (à
 *     recopier dans le tableau avant / après de la recette 108K).
 * Diagnostic GLOBAL : configuration, contrôles et compteurs par compte ; le
 * détail par document est dans le diagnostic DU COMPTE (déclaré).
 *
 * Lecture seule. Aucune valeur d'identifiant en clair (empreinte), aucun
 * texte de document ni de prompt : références, codes, compteurs, valeurs
 * normalisées de montants et de dates (déjà dans l'export).
 * ══════════════════════════════════════════════════════════════════════════
 */
type Row = Record<string, unknown>;
type Query = (sql: string, params: unknown[]) => Promise<Row[]>;

export const T1_DECISIONS_DIAGNOSTIC_SCHEMA = 'verebona.t1.value-decisions-diagnostic/1';
/** Documents inspectés par lot (diagnostic d'un compte ; aucune borne de découverte). */
const PAGE = 100;

const N = (v: unknown): number => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

function envFlag(name: string, def: string): { variable: string; raw: string | null; effective: string } {
  const raw = process.env[name]?.trim() ?? null;
  return { variable: name, raw: raw === '' ? null : raw, effective: raw === null || raw === '' ? def : raw };
}

export interface T1DecisionsDiagnostic {
  schema: string;
  generatedAt: string;
  scope: 'GLOBAL' | 'ACCOUNTS';
  configuration: Row;
  checks: Array<{ code: string; label: string; expected: string; actual: string; ok: boolean | null }>;
  accounts: Array<{ accountId: number; counters: Row; catchup: Row; documents?: Row[] }>;
  notes: string[];
  errors: string[];
}

/** Sql minimal du contrôle (`rows` → `unsafe`) adossé à la requête du diagnostic (instantané). */
const asSql = (q: Query) => ({ unsafe: (t: string, p?: unknown[]) => q(t, p ?? []) }) as never;

export async function t1DecisionsDiagnostic(q: Query, accounts: readonly number[] | null, opts: { now?: Date; withDocuments?: boolean } = {}): Promise<T1DecisionsDiagnostic> {
  const now = opts.now ?? new Date();
  const errors: string[] = [];
  const essai = async <T>(quoi: string, f: () => Promise<T>, d: T): Promise<T> => {
    try { return await f(); } catch (e) {
      // Lot 113AG (#734) : session du diagnostic interrompue (incident fatal) — arrêt, jamais une valeur par défaut ;
      // sinon erreur consignée AVEC son SQLSTATE (la première erreur reste identifiable).
      const code = (e as { code?: unknown } | null)?.code;
      if (code === 'VB_SESSION_BROKEN' || code === '25006') throw e;
      errors.push(`${quoi} : ${typeof code === 'string' ? `${code} — ` : ''}${(e as Error).message.slice(0, 200)}`);
      return d;
    }
  };
  const [{ valueDecisionsCapability, valueDecisionsEnabled, T1_VALUE_DECISIONS_CONTRACT }, review] = await Promise.all([
    import('./contract'), import('./review'),
  ]);
  const cap = await essai('contrat T1', () => valueDecisionsCapability(), { carried: false, version: null, reason: 'UNREADABLE' as const });
  const tables = await essai('migrations', async () => (await q(`SELECT to_regclass('document_value_decisions') IS NOT NULL AS d, to_regclass('document_value_review_units') IS NOT NULL AS p`, []))[0] ?? {}, {} as Row);
  const promptBo = await essai('prompt T1 actif (BO)', async () => (await q(`
      SELECT version_number, status, content_sha256, output_contract_version, activated_at
        FROM ai_master_prompt_versions WHERE treatment = 'T1' AND status = 'ACTIVE' ORDER BY activated_at DESC NULLS LAST, version_number DESC LIMIT 1`, []))[0] ?? null, null as Row | null);
  const { t1RelaunchDailyMax } = await import('@/services/coherence/registry/checks/extract-chain');
  const configuration: Row = {
    contract: T1_VALUE_DECISIONS_CONTRACT,
    effectivePrompt: { carriesMarker: cap.reason === 'CARRIED' ? true : cap.reason === 'MARKER_MISSING' ? false : null, version: cap.version, reason: cap.reason, readAt: now.toISOString(), source: 'résolution de la passerelle (version BO active, sinon fichier du dépôt)' },
    activeBoPrompt: promptBo,
    env: {
      T1_VALUE_DECISIONS_ENABLED: { ...envFlag('T1_VALUE_DECISIONS_ENABLED', '1'), enabled: valueDecisionsEnabled() },
      COHERENCE_T1_RELAUNCH_DAILY_MAX: { ...envFlag('COHERENCE_T1_RELAUNCH_DAILY_MAX', '200'), effective: String(t1RelaunchDailyMax()) },
      COHERENCE_DECISION_REVIEW_BATCHES_MAX: { ...envFlag('COHERENCE_DECISION_REVIEW_BATCHES_MAX', '5'), effective: String(review.reviewMaxBatchesPerPass()) },
    },
    reviewBounds: { unitsPerCall: review.REVIEW_MAX_UNITS, charsPerCall: review.REVIEW_MAX_CHARS, unitHardMaxChars: review.REVIEW_UNIT_HARD_MAX_CHARS, maxAttemptsPerUnit: review.REVIEW_MAX_ATTEMPTS },
    migrations: { '0798_document_value_decisions': tables.d === true, '1090_document_value_review_units': tables.p === true },
  };
  const global = accounts === null;
  const acc = global ? null : `{${accounts.filter(Number.isInteger).join(',')}}`;
  const filtre = (col: string) => (global ? 'TRUE' : `${col} = ANY($1::int[])`);
  const params = global ? [] : [acc];

  // Concordance prompt / run : version qui a répondu ≠ version effective portant le contrat (sorties récentes).
  const sorties = await essai('sorties T1', () => q(`
      SELECT e.account_id, e.metadata->'valueDecisionsOutput'->>'status' AS status, (e.metadata->'valueDecisionsOutput'->>'versionsMatch')::boolean AS concordance,
             e.metadata->'valueDecisionsOutput'->>'contract' AS contrat, e.prompt_version, count(*)::int AS n
        FROM document_extractions e WHERE ${filtre('e.account_id')} GROUP BY 1, 2, 3, 4, 5`, params), [] as Row[]);
  const decisions = tables.d === true ? await essai('décisions', () => q(`
      SELECT account_id, status, validity, COALESCE(decision, '—') AS decision, COALESCE(invalid_reason, '—') AS motif, origin, count(*)::int AS n
        FROM document_value_decisions WHERE ${filtre('account_id')} GROUP BY 1, 2, 3, 4, 5, 6`, params), [] as Row[]) : [];
  const preuves = await essai('constats', () => q(`
      SELECT account_id, last_result, COALESCE(finding->>'anomaly', '—') AS anomalie, COALESCE(finding->'detail'->>'qualification', '—') AS qualification, count(*)::int AS n
        FROM coherence_object_proofs WHERE check_id = 'COH-DOC-EXTRACT-CHAIN' AND ${filtre('account_id')} GROUP BY 1, 2, 3, 4`, params), [] as Row[]);
  const progression = tables.p === true ? await essai('progression', () => q(`
      SELECT account_id, status, COALESCE(output_status, '—') AS sortie, count(*)::int AS n, sum(attempts)::int AS tentatives
        FROM document_value_review_units WHERE ${filtre('account_id')} GROUP BY 1, 2, 3`, params), [] as Row[]) : [];
  const reexamens = await essai('réexamens', () => q(`
      SELECT account_id, outcome, count(*)::int AS n, COALESCE(sum(ai_calls), 0)::int AS appels
        FROM coherence_repairs WHERE check_id = 'COH-DOC-EXTRACT-CHAIN' AND service = 'reviewDocumentValueDecisions' AND ${filtre('account_id')} GROUP BY 1, 2`, params), [] as Row[]);
  const usage = await essai('usage IA', () => q(`
      SELECT u.account_id, COALESCE(to_jsonb(u)->>'trigger_code', u.metadata->>'triggerCode', '—') AS declencheur, count(*)::int AS n,
             COALESCE(sum(u.cost_micros), 0)::bigint AS cout
        FROM ai_usage_event u WHERE u.operation_code = 't1_analyze_document' AND ${filtre('u.account_id')}
         AND COALESCE(to_jsonb(u)->>'trigger_code', u.metadata->>'triggerCode') = 't1_value_decision_review' GROUP BY 1, 2`, params), [] as Row[]);

  const comptes = new Set<number>([...sorties, ...decisions, ...preuves, ...progression, ...reexamens, ...usage].map((r) => Number(r.account_id)).filter(Number.isInteger));
  if (!global) for (const a of accounts) comptes.add(a);
  const de = (l: Row[], a: number) => l.filter((r) => Number(r.account_id) === a);
  const somme = (l: Row[], cle: (r: Row) => string, champ = 'n') => l.reduce<Record<string, number>>((m, r) => { const k = cle(r); m[k] = (m[k] ?? 0) + N(r[champ]); return m; }, {});
  const { extractChainCheck, inspectExtractChain } = await import('@/services/coherence/registry/checks/extract-chain');
  const out: T1DecisionsDiagnostic['accounts'] = [];
  for (const a of [...comptes].sort((x, y) => x - y)) {
    const s = de(sorties, a);
    const dd = de(decisions, a);
    const counters: Row = {
      t1Outputs: {
        byStatus: somme(s, (r) => String(r.status ?? 'NON_CONSIGNÉ (analyse antérieure au lot 108K)')),
        versionMismatch: s.filter((r) => r.concordance === false).reduce((n, r) => n + N(r.n), 0),
        byContractAtAnalysis: somme(s, (r) => String(r.contrat ?? '—')),
        byPromptVersion: somme(s, (r) => String(r.prompt_version ?? '—')),
      },
      decisions: {
        active: somme(dd.filter((r) => r.status === 'ACTIVE'), (r) => `${r.validity}:${r.decision}`),
        activeInvalidByReason: somme(dd.filter((r) => r.status === 'ACTIVE' && r.validity === 'INVALID'), (r) => String(r.motif)),
        superseded: dd.filter((r) => r.status === 'SUPERSEDED').reduce((n, r) => n + N(r.n), 0),
        byOrigin: somme(dd, (r) => String(r.origin)),
      },
      extractChain: {
        byResult: somme(de(preuves, a), (r) => String(r.last_result)),
        byAnomaly: somme(de(preuves, a), (r) => String(r.anomalie)),
        byQualification: somme(de(preuves, a), (r) => String(r.qualification)),
      },
      reviewProgress: { units: somme(de(progression, a), (r) => `${r.status}:${r.sortie}`), attempts: de(progression, a).reduce((n, r) => n + N(r.tentatives), 0) },
      reviews: { byOutcome: somme(de(reexamens, a), (r) => String(r.outcome)), aiCalls: de(reexamens, a).reduce((n, r) => n + N(r.appels), 0) },
      aiUsage: { reviewCalls: de(usage, a).reduce((n, r) => n + N(r.n), 0), reviewCostMicros: de(usage, a).reduce((n, r) => n + N(r.cout), 0) },
    };
    // Rattrapage SIMULÉ : même sélection que le rattrapage BO 18 (lecture seule, aucune demande écrite).
    const candidats = await essai(`rattrapage compte ${a}`, () => extractChainCheck.catchupCandidates!({ sql: asSql(q), now, limit: 5_000, accountId: a, apply: false }), []);
    const catchup: Row = { wouldRequest: candidats.length, documents: candidats.map((c) => c.objectId), contract: cap.reason };
    const entry: T1DecisionsDiagnostic['accounts'][number] = { accountId: a, counters, catchup };
    if (!global && opts.withDocuments !== false) {
      const ids = (await essai(`documents compte ${a}`, () => q(`
          SELECT f.id, coalesce(f.retained_title, f.original_filename) AS titre FROM asset_files f
            JOIN document_extraction_coverage c ON c.file_id = f.id AND c.account_id = f.account_id
           WHERE f.account_id = $1 AND f.deleted_at IS NULL ORDER BY f.id`, [a]), [] as Row[]));
      const docs: Row[] = [];
      for (let i = 0; i < ids.length; i += PAGE) {
        const lot = ids.slice(i, i + PAGE);
        const insp = await essai(`inspection compte ${a}`, () => inspectExtractChain({ sql: asSql(q), now }, a, lot.map((r) => Number(r.id)), { fullDetail: true }), new Map());
        for (const r of lot) {
          const x = insp.get(Number(r.id));
          if (!x) { docs.push({ fileId: Number(r.id), title: r.titre ?? null, verdict: 'NON_INSPECTÉ' }); continue; }
          const d = (x.detail ?? {}) as Row;
          docs.push({
            fileId: Number(r.id), title: r.titre ?? null, verdict: x.verdict, anomaly: x.anomaly ?? null, repair: d.repair ?? null,
            qualification: d.qualification ?? null, motive: d.motive ?? null, omissionTotals: d.omissionTotals ?? null, review: d.review ?? null,
            valueDecisions: d.valueDecisions ?? null, valueDecisionsOutput: d.valueDecisionsOutput ?? null, relaunchBudgetReached: d.relaunchBudgetReached === true,
            omissions: d.allOmissions ?? [], undetermined: d.allUndetermined ?? [], justified: d.allJustified ?? [],
          });
        }
      }
      entry.documents = docs;
    }
    out.push(entry);
  }

  const versionsDiscordantes = out.reduce((n, x) => n + N((x.counters.t1Outputs as Row).versionMismatch), 0);
  const checks: T1DecisionsDiagnostic['checks'] = [
    { code: 'MARKER', label: 'Prompt T1 effectif porte le marqueur t1-value-decisions-v1', expected: 'oui', actual: cap.reason === 'CARRIED' ? 'oui' : `non (${cap.reason})`, ok: cap.reason === 'CARRIED' },
    { code: 'SWITCH', label: 'Interrupteur T1_VALUE_DECISIONS_ENABLED', expected: 'actif (absent ou ≠ 0)', actual: valueDecisionsEnabled() ? 'actif' : 'coupé (0)', ok: valueDecisionsEnabled() },
    { code: 'TABLE_0798', label: 'Table des décisions (migration 0798)', expected: 'présente', actual: tables.d === true ? 'présente' : 'absente', ok: tables.d === true },
    { code: 'TABLE_1090', label: 'Table de progression des réexamens (migration 1090)', expected: 'présente', actual: tables.p === true ? 'présente' : 'absente', ok: tables.p === true },
    { code: 'VERSIONS', label: 'Version du prompt qui a répondu = version effective (analyses consignées)', expected: '0 écart', actual: `${versionsDiscordantes} écart(s)`, ok: versionsDiscordantes === 0 },
  ];
  return {
    schema: T1_DECISIONS_DIAGNOSTIC_SCHEMA, generatedAt: now.toISOString(), scope: global ? 'GLOBAL' : 'ACCOUNTS', configuration, checks, accounts: out,
    notes: [
      'État du prompt et des variables lu en direct au moment du diagnostic ; données lues dans l’instantané du diagnostic.',
      global ? 'Diagnostic global : compteurs par compte ; le bilan par document et par unité est dans le diagnostic du compte.' : 'Bilan par document calculé par le contrôle COH-DOC-EXTRACT-CHAIN lui-même (lecture seule, aucun appel IA), détail complet.',
      'Identifiants : empreinte (#…) ; montants en centimes ; dates AAAA-MM-JJ.',
      'Rattrapage : simulation de la sélection du rattrapage BO 18 (Exploitation › Rattrapages › « Omissions documentaires T1 »).',
    ],
    errors,
  };
}

/** Tableau lisible (à recopier dans la recette 108K). Pur. */
export function t1DecisionsDiagnosticText(d: T1DecisionsDiagnostic): string {
  const l: string[] = [];
  l.push('T1 — DÉCISIONS SUR LES VALEURS SIGNIFICATIVES (lot 108K)', `Généré le ${d.generatedAt}`, '');
  l.push('CONTRÔLES DE CONFIGURATION (attendu → constaté)');
  for (const c of d.checks) l.push(`  [${c.ok === null ? '??' : c.ok ? 'OK' : 'KO'}] ${c.label} : attendu ${c.expected} → ${c.actual}`);
  const p = d.configuration.effectivePrompt as Row;
  l.push(`  Prompt T1 effectif : version ${String(p.version ?? '—')} (${String(p.reason)})`, '');
  for (const a of d.accounts) {
    const c = a.counters as Record<string, Row>;
    l.push(`COMPTE ${a.accountId}`);
    l.push(`  Sorties T1 : ${JSON.stringify(c.t1Outputs.byStatus)} · versions discordantes ${String(c.t1Outputs.versionMismatch)}`);
    l.push(`  Décisions actives : ${JSON.stringify(c.decisions.active)} · invalides par motif ${JSON.stringify(c.decisions.activeInvalidByReason)} · historisées ${String(c.decisions.superseded)}`);
    l.push(`  Constats : ${JSON.stringify(c.extractChain.byAnomaly)} · qualifications ${JSON.stringify(c.extractChain.byQualification)}`);
    l.push(`  Réexamens : ${JSON.stringify(c.reviews.byOutcome)} · appels IA ${String(c.reviews.aiCalls)} · coût ${(N(c.aiUsage.reviewCostMicros) / 1e6).toFixed(4)} € · unités ${JSON.stringify(c.reviewProgress.units)}`);
    l.push(`  Rattrapage (simulation) : ${String(a.catchup.wouldRequest)} document(s) à reprendre`);
    if (a.documents) {
      l.push('  Document | verdict | anomalie | omissions (unités/valeurs) | justifiées | indéterminées | invalides | examinées/restantes | tentatives | arrêts | sortie T1');
      for (const x of a.documents) {
        const o = (x.omissionTotals ?? {}) as Row;
        const r = (x.review ?? {}) as Row;
        const v = (x.valueDecisions ?? {}) as Row;
        const s = (x.valueDecisionsOutput ?? {}) as Row;
        l.push(`  ${String(x.fileId)} | ${String(x.verdict)} | ${String(x.anomaly ?? '—')} | ${N(o.units)}/${N(o.values)} | ${N(v.justified)} | ${N(v.undetermined)} | ${N(v.invalid)} | `
          + `${N(r.examined)}/${N(r.remaining)} | ${N(r.attempts)} | ${((r.stopReasons as string[] | undefined) ?? []).concat(x.relaunchBudgetReached ? ['RELAUNCH_BUDGET'] : []).join(',') || '—'} | ${String(s.status ?? '—')}`);
        for (const u of (x.omissions as Row[]) ?? []) {
          l.push(`      · unité ${String(u.unit)} (${String(u.kind)}, ${String(u.status)}, réexamen ${String(u.review ?? '—')}) : ${((u.values as Row[]) ?? []).map((y) => `${String(y.kind)} ${String(y.value)} [${String((y.decision as Row | undefined)?.state ?? 'sans contrat')}${(y.decision as Row | undefined)?.code ? ` ${String((y.decision as Row).code)}` : ''}]`).join(' ; ')}`);
        }
      }
    }
    l.push('');
  }
  if (d.errors.length) l.push('ERREURS DE LECTURE', ...d.errors.map((e) => `  ${e}`));
  return `${l.join('\n')}\n`;
}
