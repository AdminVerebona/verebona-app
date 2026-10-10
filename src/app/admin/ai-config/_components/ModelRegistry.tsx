'use client';

/**
 * Registre des modèles — lecture seule (CDC Assistant §15.12, §15.13,
 * §15.14, §32.6 « visualiser les dates de dépréciation des modèles » ; lot 23).
 *
 * Section repliée de Configuration IA, mêmes composants et mêmes tables que
 * les réglages de l'assistant : alias de l'assistant résolus (statut, dates,
 * prix, limites, qualification, rollback), modèles connus — exceptions
 * Verebona, catalogue découvert chez Google, modèles en usage — avec statut
 * fournisseur (Preview visible), qualification technique automatique, tarif
 * KNOWN / UNKNOWN (jamais inventé), contrôle de cohérence, verdict du
 * contrôle de démarrage. Rien ne s'édite ici (lot 35B : plus de réglage
 * preview). Tables en défilement horizontal : même rendu desktop et mobile.
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';

interface Qualification {
  source: 'auto' | 'historical'; generate: boolean | null; structured: boolean | null;
  multimodal: boolean | null; thinking: boolean | null; qualifiedAt: string | null;
}
interface Model {
  provider: string; model: string | null; status: string; statusLabel?: string;
  activatedOn: string | null; retiresOn: string | null; capabilities: string[];
  price: { inputPerMillion: number; outputPerMillion: number; source: string | null } | null;
  contextWindowTokens: number | null; maxOutputTokens: number | null;
  rateLimits: { requestsPerMinute: number | null; tokensPerMinute: number | null };
  qualification: Qualification | null; exclusion?: string | null;
  rollbackModel: string | null; note?: string | null;
  usedBy?: string[];
  pricing?: { status: 'KNOWN' | 'UNKNOWN'; reason: string | null; fetchedAt: string | null; lastChangedAt: string | null };
  available?: boolean | null; declared?: boolean; firstSeenAt?: string | null; displayName?: string | null;
}
interface AliasRow extends Model {
  role: 'default' | 'escalation'; alias: string; compatibleSchemas: string[];
  limits: { maxInputTokens: number; maxOutputTokens: number | null; timeoutMs: number; maxCallsPerMessage: number };
}
interface Issue { level: 'error' | 'warning'; code: string; where: string; model: string; message: string }
interface Data {
  registryVersion: string; declaredModelsVersion: string;
  aliases: AliasRow[]; models: Model[]; coherence: Issue[];
  startup: { verdict: { ok: true } | { ok: false; error: string } | null; lastValid: { checkedAt: string; aliases: Record<string, string> } | null };
  notes: string[];
}

const STATUT: Record<string, string> = {
  stable: 'text-emerald-500', preview: 'text-amber-500', experimental: 'text-red-400', deprecated: 'text-red-400', unknown: 'text-[color:var(--text-muted)]',
};
const LIBELLE: Record<string, string> = {
  stable: 'Stable', preview: 'Preview', experimental: 'Expérimental (exclu)', deprecated: 'Déprécié', unknown: 'Non communiqué',
};
const CAP: Record<string, string> = { structured_output: 'sorties structurées', multimodal: 'multimodal', thinking: 'raisonnement' };
const QCAP: Array<[keyof Qualification, string]> = [['generate', 'génération'], ['structured', 'schéma JSON'], ['multimodal', 'multimodal'], ['thinking', 'raisonnement']];
const qualif = (q: Qualification | null) => {
  if (!q) return 'en attente';
  const parts = QCAP.map(([k, l]) => `${q[k] === true ? '✓' : q[k] === false ? '✗' : '?'} ${l}`).join(' · ');
  return `${q.source === 'auto' ? 'auto' : 'historique'} — ${parts}`;
};
const tarif = (m: Model) => (m.pricing?.status === 'UNKNOWN'
  ? `UNKNOWN${m.pricing.reason ? ` (${m.pricing.reason})` : ''}`
  : prix(m.price));

const nb = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('fr-FR'));
const date = (v: string | null) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString('fr-FR') : '—');
const prix = (p: Model['price']) => (p ? `${p.inputPerMillion} $ / ${p.outputPerMillion} $` : 'absent');
const debit = (r: Model['rateLimits']) =>
  r.requestsPerMinute == null && r.tokensPerMinute == null ? 'palier fournisseur' : `${nb(r.requestsPerMinute)} req/min · ${nb(r.tokensPerMinute)} tok/min`;

const TH = 'py-1 pr-3 font-medium';
const TD = 'py-1 pr-3 align-top';

export function ModelRegistry() {
  const [data, setData] = useState<Data | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Data>('/api/admin/ai/model-registry'));
    } catch {
      toast.error('Registre des modèles indisponible.');
    }
  }, []);

  const erreurs = data?.coherence.filter((i) => i.level === 'error') ?? [];
  const avertissements = data?.coherence.filter((i) => i.level === 'warning') ?? [];
  const verdict = data?.startup.verdict;

  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
      data-testid="model-registry"
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !data) void load(); }}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Registre des modèles · alias, statuts, dépréciations
        {erreurs.length > 0 && <span className="ml-2 text-xs text-red-400">• {erreurs.length} incohérence(s)</span>}
        {verdict && !verdict.ok && <span className="ml-2 text-xs text-red-400">• contrôle de démarrage en échec</span>}
      </summary>
      {!data ? (
        <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p>
      ) : (
        <div className="px-4 pb-4 space-y-5">
          <p className="text-xs text-[color:var(--text-muted)]">
            Lecture seule ({data.registryVersion} · {data.declaredModelsVersion}). Les alias changent par une version de configuration.
            Un modèle est utilisable s’il est servi par la clé active et a réussi sa qualification technique (preview compris, statut
            affiché ; expérimental exclu). Prix : page officielle Google synchronisée (USD par million de jetons) ; UNKNOWN = coût non
            calculable, jamais estimé.
          </p>

          {verdict && (
            <p className={`text-xs ${verdict.ok ? 'text-emerald-500' : 'text-red-400'}`}>
              Contrôle de démarrage : {verdict.ok ? 'conforme' : verdict.error}
              {data.startup.lastValid && (
                <span className="text-[color:var(--text-muted)]">
                  {' '}· dernier registre valide du {formatDateTime(data.startup.lastValid.checkedAt)} :{' '}
                  {Object.entries(data.startup.lastValid.aliases).map(([a, m]) => `${a} → ${m || '—'}`).join(', ')}
                </span>
              )}
            </p>
          )}

          {(erreurs.length > 0 || avertissements.length > 0) && (
            <div className="space-y-1">
              {erreurs.map((i, k) => <p key={`e${k}`} className="text-xs text-red-400">{i.message}</p>)}
              {avertissements.map((i, k) => <p key={`w${k}`} className="text-xs text-amber-500">{i.message}</p>)}
            </div>
          )}

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Alias de l’assistant (§15.11, §15.12)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[color:var(--text-muted)]">
                    <th className={TH}>Alias</th><th className={TH}>Modèle</th><th className={TH}>Statut</th>
                    <th className={TH}>Activé le</th><th className={TH}>Fin prévue</th><th className={TH}>Prix entrée / sortie</th>
                    <th className={TH}>Contexte · sortie max</th><th className={TH}>Limites Verebona</th><th className={TH}>Débit</th>
                    <th className={TH}>Qualification · schémas</th><th className={TH}>Rollback</th>
                  </tr>
                </thead>
                <tbody>
                  {data.aliases.map((a) => (
                    <tr key={a.alias} className="border-t border-[color:var(--border-subtle)] text-[color:var(--text-primary)]">
                      <td className={`${TD} font-mono`}>{a.alias}</td>
                      <td className={`${TD} font-mono`}>{a.provider}/{a.model ?? '—'}</td>
                      <td className={`${TD} ${STATUT[a.status] ?? ''}`}>{LIBELLE[a.status] ?? a.status}</td>
                      <td className={TD}>{date(a.activatedOn)}</td>
                      <td className={TD}>{date(a.retiresOn)}</td>
                      <td className={TD}>{tarif(a)}</td>
                      <td className={TD}>{nb(a.contextWindowTokens)} · {nb(a.maxOutputTokens)}</td>
                      <td className={TD}>
                        entrée {nb(a.limits.maxInputTokens)} · sortie {nb(a.limits.maxOutputTokens)} · {a.limits.timeoutMs / 1000} s · {a.limits.maxCallsPerMessage} appels/message
                      </td>
                      <td className={TD}>{debit(a.rateLimits)}</td>
                      <td className={TD}>{qualif(a.qualification)}{a.compatibleSchemas.length ? <span className="font-mono"> · {a.compatibleSchemas.join(', ')}</span> : null}</td>
                      <td className={`${TD} font-mono`}>{a.rollbackModel ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Modèles connus : exceptions Verebona, catalogue Google, usage effectif</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[color:var(--text-muted)]">
                    <th className={TH}>Modèle</th><th className={TH}>Statut</th><th className={TH}>Disponibilité</th>
                    <th className={TH}>Fin prévue</th><th className={TH}>Qualification</th><th className={TH}>Tarif entrée / sortie</th>
                    <th className={TH}>Contexte · sortie max</th><th className={TH}>Exception Verebona</th><th className={TH}>Rollback</th>
                    <th className={TH}>Utilisé par</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((m) => (
                    <tr key={m.model ?? ''} className="border-t border-[color:var(--border-subtle)] text-[color:var(--text-primary)]">
                      <td className={`${TD} font-mono`} title={[m.displayName, m.note].filter(Boolean).join(' — ') || undefined}>{m.model}</td>
                      <td className={`${TD} ${STATUT[m.status] ?? ''}`}>{LIBELLE[m.status] ?? m.status}</td>
                      <td className={TD}>
                        {m.available == null ? 'jamais listé' : m.available ? 'listé' : <span className="text-red-400">retiré</span>}
                        {m.firstSeenAt ? <span className="text-[color:var(--text-muted)]"> · vu le {formatDateTime(m.firstSeenAt)}</span> : null}
                      </td>
                      <td className={TD}>{date(m.retiresOn)}</td>
                      <td className={TD}>{qualif(m.qualification)}</td>
                      <td className={m.pricing?.status === 'UNKNOWN' ? `${TD} text-amber-500` : TD}>{tarif(m)}</td>
                      <td className={TD}>{nb(m.contextWindowTokens)} · {nb(m.maxOutputTokens)}</td>
                      <td className={TD}>{m.exclusion ?? (m.declared ? (m.capabilities.map((c) => CAP[c] ?? c).join(', ') || '—') : '—')}</td>
                      <td className={`${TD} font-mono`}>{m.rollbackModel ?? '—'}</td>
                      <td className={TD}>{m.usedBy?.length ? m.usedBy.join(' ; ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.notes.map((n, i) => <p key={i} className="text-xs text-[color:var(--text-muted)]">{n}</p>)}
        </div>
      )}
    </details>
  );
}
