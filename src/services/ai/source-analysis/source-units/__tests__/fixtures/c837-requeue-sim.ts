/**
 * Carte Trello #837 — double EN MÉMOIRE de `t1_requeue_requests` (migrations
 * 1805 + 1970) pour les tests unitaires à base simulée : il interprète les
 * instructions étiquetées `/* c837:… *\/` de `requeue-identity.ts` et de
 * `jobs.ts` avec la MÊME sémantique que PostgreSQL (insertion conditionnelle,
 * verrou, bail à jeton, transitions conditionnelles, `RETURNING`).
 * Le SQL réel est prouvé par le scénario `c837-t1-residus-115h.e2e.ts`.
 */
export interface DemandeSimulee {
  id: number; account_id: number; file_id: number; request_key: string; state: string;
  origin: string; requested_by: string; evidence_fingerprint: string | null;
  reserved_attempt: number | null; attempt_consumed: boolean; job_id: number | null; reason: string | null;
  steps: Record<string, unknown>; lease_token: string | null; lease_expires_at: number | null;
  cycles: number; history: unknown[]; campaign_ref: string | null; updated_at: number;
}

export function creerSimulateurDemandes(opts: { couverture: () => { retryAttempts: number } | null }) {
  const store = { lignes: [] as DemandeSimulee[], seq: 0, suites: [] as unknown[][], maintenant: () => Date.now() };
  const vivant = (l: DemandeSimulee) => l.lease_token !== null && l.lease_expires_at !== null && l.lease_expires_at > store.maintenant();
  const vue = (l: DemandeSimulee) => ({ ...l, lease_alive: vivant(l), lease_expired: !vivant(l) });
  const trouver = (id: unknown) => store.lignes.find((l) => l.id === Number(id));
  const archiver = (l: DemandeSimulee) => {
    if (l.state !== 'OPEN') l.history.push({ state: l.state, steps: { ...l.steps }, jobId: l.job_id, reason: l.reason, origin: l.origin, requestedBy: l.requested_by });
  };
  /** `undefined` : instruction non prise en charge par ce double. */
  function traiter(x: string, params: unknown[]): unknown[] | undefined {
    const p = params as unknown[];
    if (x.includes('/* c837:req-insert */')) {
      const [account_id, file_id, request_key, origin, requested_by, fp, campaign] = p as [number, number, string, string, string, string, string | null];
      if (store.lignes.some((l) => l.account_id === account_id && l.file_id === file_id && l.request_key === request_key)) return [];
      const l: DemandeSimulee = {
        id: ++store.seq, account_id, file_id, request_key, state: 'OPEN', origin, requested_by, evidence_fingerprint: fp,
        reserved_attempt: null, attempt_consumed: false, job_id: null, reason: null, steps: {}, lease_token: null, lease_expires_at: null,
        cycles: 0, history: [], campaign_ref: campaign ?? null, updated_at: store.maintenant(),
      };
      store.lignes.push(l);
      return [{ id: l.id }];
    }
    if (x.includes('/* c837:req-read */') || x.includes('/* c837:req-lock */')) {
      const [account_id, file_id, request_key] = p as [number, number, string];
      return store.lignes.filter((l) => l.account_id === account_id && l.file_id === file_id && l.request_key === request_key).map(vue);
    }
    if (x.includes('/* c837:cov-lock */')) {
      const c = opts.couverture();
      return c ? [{ retry_attempts: c.retryAttempts }] : [];
    }
    if (x.includes('/* c837:req-resume */')) {
      const l = trouver(p[0]);
      if (l && l.state === 'RESERVED') { l.lease_token = String(p[1]); l.lease_expires_at = store.maintenant() + Number(p[2]) * 1000; }
      return [];
    }
    if (x.includes('/* c837:req-refuse */')) {
      const l = trouver(p[0])!;
      archiver(l);
      Object.assign(l, { state: 'REFUSED', reason: String(p[1]), steps: { refused: true }, origin: p[2], requested_by: p[3], lease_token: null, lease_expires_at: null });
      return [];
    }
    if (x.includes('/* c837:req-reserve */')) {
      const l = trouver(p[0]);
      if (!l) return [];
      archiver(l);
      Object.assign(l, {
        state: 'RESERVED', reserved_attempt: p[1] == null ? null : Number(p[1]), attempt_consumed: false, job_id: null, reason: null,
        steps: { reserved: true }, lease_token: String(p[2]), lease_expires_at: store.maintenant() + Number(p[3]) * 1000,
        origin: p[4], requested_by: p[5], evidence_fingerprint: p[6], campaign_ref: p[7] ?? l.campaign_ref, cycles: l.cycles + 1,
      });
      return [{ id: l.id }];
    }
    if (x.includes('/* c837:req-step */')) {
      const l = trouver(p[0]);
      if (!l || l.lease_token !== String(p[1]) || l.state !== 'RESERVED') return [];
      Object.assign(l.steps, JSON.parse(String(p[2])) as Record<string, unknown>);
      if (p[3] != null) l.job_id = Number(p[3]);
      if (p[4] != null) l.reason = String(p[4]);
      l.lease_expires_at = store.maintenant() + Number(p[5]) * 1000;
      return [{ id: l.id }];
    }
    if (x.includes('/* c837:req-note */')) {
      const l = trouver(p[0]);
      if (!l || l.state !== String(p[1])) return [];
      if (p[2] != null) l.state = String(p[2]);
      if (p[3] != null) l.job_id = Number(p[3]);
      l.reason = String(p[4]);
      l.steps.inspected = true;
      return [{ id: l.id }];
    }
    if (x.includes('/* c837:req-final */')) {
      const l = trouver(p[0]);
      if (!l || l.lease_token !== String(p[1]) || l.state !== 'RESERVED') return [];
      Object.assign(l, { state: String(p[2]), attempt_consumed: p[3] === true, reason: p[5] ?? null, lease_token: null, lease_expires_at: null });
      if (p[4] != null) l.job_id = Number(p[4]);
      l.steps.counted = true;
      return [{ id: l.id }];
    }
    if (x.includes('/* c837:req-diag */')) {
      const l = trouver(p[0]);
      if (!l || l.state !== String(p[1])) return [];
      l.steps.diagnosed = true;
      return [{ id: l.id }];
    }
    if (x.includes('/* c837:followup */')) { store.suites.push(p); return []; }
    return undefined;
  }
  return { store, traiter };
}
