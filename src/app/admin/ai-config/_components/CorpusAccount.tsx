'use client';

/**
 * Compte technique de qualification — lot 103G (ticket P1 « compte technique
 * de qualification »).
 *
 * Section repliée de Configuration IA (écran existant) : le PO constate et
 * répare le prérequis des campagnes de qualification SANS accès à la base :
 *   · état (motif CORPUS_ACCOUNT_OK / MISSING / MISMATCH / INVALID), compte
 *     reconnu, variable CORPUS_ACCOUNT_ID (déclarée, cohérente, obsolète),
 *     raisons et prochain geste ;
 *   · incompatibilités de prompts et campagnes bloquées par ce prérequis, cas
 *     du corpus concernés, reprises automatiques ;
 *   · « Contrôler » (Supervision mise à jour) et « Provisionner / réparer »
 *     (mécanisme unique, idempotent, journalisé) — la reprise des essais
 *     bloqués est ensuite AUTOMATIQUE au passage suivant.
 * Cartes empilées : desktop et mobile, aucune table à défilement horizontal ;
 * boutons ≥ 44 px en mobile.
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

interface Status {
  ok: boolean; code: string; label: string; accountId: number | null; markedAccountId: number | null; security: boolean;
  variable: { declared: boolean; value: number | null; readable: boolean; matches: boolean | null; stale: boolean };
  resolvedBy: string | null; reasons: string[]; warnings: string[]; nextAction: string | null; checkedAt: string;
}
interface Diagnostic {
  readAt: string; environment: string; status: Status; autoProvision: { allowed: boolean; variable: string };
  conformity: Array<{ issueId: number; contractId: string; treatment: string; status: string; code: string | null; since: string | null; resumes: number }>;
  campaigns: Array<{ id: number; kind: string; status: string; code: string | null; stage: string | null; cases: string[]; at: string | null }>;
  resumes: Array<{ issueId: number; contractId: string; at: string; message: string }>;
  blockedCases: string[];
}

const TONE = {
  ok: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  ko: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  warn: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning)] border-[color:var(--border-warning)]',
};

export function CorpusAccount() {
  const [data, setData] = useState<Diagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Diagnostic>('/api/admin/ai/corpus-account'));
    } catch {
      toast.error('État du compte technique indisponible.');
    }
  }, []);
  const agir = async (action: 'check' | 'provision') => {
    setBusy(true);
    try {
      const r = await apiClient.post<{ message?: string; status: Status }>('/api/admin/ai/corpus-account', { action });
      if (r.status.ok) toast.success(action === 'provision' ? `${r.message ?? 'Compte technique prêt.'} Les essais bloqués reprendront au prochain passage.` : 'Compte technique utilisable.');
      else toast.error(`${r.status.code} : ${r.status.label}.`);
      await load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Action impossible.');
    } finally {
      setBusy(false);
    }
  };
  const st = data?.status;
  const v = st?.variable;
  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
      data-testid="corpus-account"
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !data) void load(); }}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Compte technique de qualification · prérequis des campagnes et des mises en conformité
        {st && !st.ok && <span className="ml-2 text-xs text-[color:var(--text-warning-soft)]">• {st.code}</span>}
      </summary>
      {!data || !st || !v ? (
        <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p>
      ) : (
        <div className="px-4 pb-4 space-y-3 min-w-0">
          <div className={`rounded-lg border p-2 text-xs space-y-1 break-words ${st.ok ? TONE.ok : st.security ? TONE.ko : TONE.warn}`} data-testid="corpus-account-status">
            <p className="font-medium">{st.code} — {st.label}</p>
            {st.reasons.map((r, k) => <p key={k}>{r}</p>)}
            {st.warnings.map((r, k) => <p key={`w${k}`}>{r}</p>)}
            {st.nextAction && <p><span className="font-medium">Prochain geste : </span>{st.nextAction}</p>}
          </div>
          <p className="text-xs text-[color:var(--text-secondary)] break-words">
            Environnement {data.environment} · compte reconnu : {st.accountId ?? st.markedAccountId ?? 'aucun'}{st.resolvedBy ? ` (par ${st.resolvedBy === 'marker' ? 'son marqueur en base' : 'la variable'})` : ''}
            {' '}· CORPUS_ACCOUNT_ID : {v.declared ? (v.readable ? `${v.value}${v.matches === true ? ' (cohérente)' : v.stale ? ' (obsolète)' : v.matches === false ? ' (incohérente)' : ''}` : 'illisible') : 'non déclarée (facultative)'}
            {' '}· auto-provisionnement : {data.autoProvision.allowed ? 'actif' : 'inactif'} ({data.autoProvision.variable}) · lu le {formatDateTime(data.readAt)}.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => void agir('check')}>
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Contrôler
            </Button>
            <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy || st.ok} onClick={() => void agir('provision')} data-testid="corpus-account-provision">
              <Wrench className="w-3.5 h-3.5 mr-1.5" /> Provisionner / réparer
            </Button>
            <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
            </Button>
          </div>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Le compte technique n’est ni connectable ni facturable ; il ne remplace jamais un compte client. Une fois réparé, les incompatibilités et campagnes
            bloquées pour cette seule cause reprennent automatiquement au passage suivant (aucun « Nouvel essai » nécessaire). Les vrais refus restent bloqués.
          </p>
          {data.conformity.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-[color:var(--text-primary)]">Mises en conformité en attente de ce prérequis ({data.conformity.length})</h3>
              <ul className="text-xs text-[color:var(--text-secondary)] space-y-0.5">
                {data.conformity.map((c) => <li key={c.issueId} className="break-words">{c.treatment} · <code>{c.contractId}</code> · {c.code ?? '—'}{c.since ? ` depuis le ${formatDateTime(c.since)}` : ''}{c.resumes ? ` · ${c.resumes} reprise(s)` : ''}</li>)}
              </ul>
            </div>
          )}
          {data.campaigns.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Campagnes refusées ou bloquées par ce prérequis ({data.campaigns.length})</summary>
              <ul className="mt-1 text-xs text-[color:var(--text-secondary)] space-y-0.5">
                {data.campaigns.map((c) => <li key={c.id} className="break-words">n° {c.id} · {c.kind} · {c.code ?? '—'} ({c.stage === 'PRECHECK' ? 'refus avant tout appel' : 'cas bloqués en cours'}){c.cases.length ? ` · ${c.cases.join(', ')}` : ''}{c.at ? ` · ${formatDateTime(c.at)}` : ''}</li>)}
              </ul>
            </details>
          )}
          {data.resumes.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Reprises automatiques ({data.resumes.length})</summary>
              <ul className="mt-1 text-xs text-[color:var(--text-secondary)] space-y-0.5">
                {data.resumes.map((r, k) => <li key={k} className="break-words">{formatDateTime(r.at)} · <code>{r.contractId}</code> · {r.message}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </details>
  );
}
