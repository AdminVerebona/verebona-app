'use client';

/**
 * Profils par opération et par rang — lot 85C (CDC Pilotage IA V2 P4 :
 * CFG-01, CFG-02, OP-03, R03, R35 ; décisions PO 08 et 09).
 *
 * Dans l'éditeur d'un traitement (Configuration IA, écran existant) : pour
 * chaque opération modèle du traitement (liste lue dans le registre par le
 * serveur), un profil FACULTATIF qui s'écarte de la référence du traitement —
 * niveau de raisonnement et plafond de sortie PAR RANG (principal, repli 1,
 * repli 2), délai. Vide = hérité (affiché comme tel). La température n'est
 * pas un champ (réglage technique par famille de modèles).
 *
 * Sous chaque opération, les PROFILS EFFECTIFS de la version enregistrée,
 * construits par le serveur avec le constructeur de requête de l'exécution :
 * valeur envoyée, adaptation à la limite du modèle, refus avant appel.
 * Desktop et mobile : même composant, grille d'une colonne sous `sm`.
 */
import { Input } from '@/components/ui/input';

export interface OperationProfile {
  reasoningByRank?: Array<string | null>;
  maxOutputTokensByRank?: Array<number | null>;
  timeoutMs?: number | null;
}
export interface ProfiledOperation {
  operationCode: string; label: string; task: string | null; timeoutMs: number; minTimeoutMs: number;
  minOutputTokens: number | null; imageInput: boolean;
}
export interface PlanView {
  operationCode: string; rank: number; slot: string; model: string;
  reasoning: { requested: string | null; origin: string; sent: string | null };
  maxOutputTokens: { requested: number | null; origin: string; modelLimit: number | null; adapted: number | null; sent: number | null };
  timeoutMs: number; timeoutOrigin: string;
  temperature: { profile: string | null; sent: number | null };
  adaptations: Array<{ parameter: string; reason: string; requested: unknown; sent: unknown }>;
  refusal: { parameter: string; message: string } | null;
}

const SLOTS = [['primaryModel', 'Principal'], ['fallback1', 'Repli 1'], ['fallback2', 'Repli 2']] as const;
const ORIGINE: Record<string, string> = {
  operation_rank: 'profil (ce rang)', operation: 'profil de l’opération', treatment: 'référence du traitement', code: 'valeur du code', none: 'défaut du modèle',
};
const selectClass = 'h-9 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-input)] px-2 text-sm text-[color:var(--text-primary)]';

function clean(p: OperationProfile): OperationProfile | null {
  const trim = <T,>(a?: Array<T | null>) => {
    if (!a) return undefined;
    const out = [...a];
    while (out.length && (out[out.length - 1] === null || out[out.length - 1] === undefined)) out.pop();
    return out.length ? out : undefined;
  };
  const r = trim(p.reasoningByRank);
  const m = trim(p.maxOutputTokensByRank);
  const out: OperationProfile = { ...(r ? { reasoningByRank: r } : {}), ...(m ? { maxOutputTokensByRank: m } : {}), ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}) };
  return Object.keys(out).length ? out : null;
}

export function OperationProfilesEditor({
  entry, operations, reasoningLevels, profiles, plans, readOnly, unsaved, onChange,
}: {
  entry: { primaryModel: string | null; fallback1: string | null; fallback2: string | null; maxOutputTokens: number | null };
  operations: ProfiledOperation[];
  reasoningLevels: string[];
  profiles: Record<string, OperationProfile>;
  /** Profils effectifs de la version ENREGISTRÉE (serveur), par opération. */
  plans: PlanView[] | null;
  readOnly: boolean;
  /** Modifications non enregistrées sur ce traitement : les profils effectifs datent de la version enregistrée. */
  unsaved: boolean;
  onChange: (next: Record<string, OperationProfile>) => void;
}) {
  if (operations.length === 0) return null;
  const present = [Boolean(entry.primaryModel), Boolean(entry.fallback1), Boolean(entry.fallback2)];
  const setOp = (code: string, p: OperationProfile) => {
    const next = { ...profiles };
    const c = clean(p);
    if (c) next[code] = c; else delete next[code];
    onChange(next);
  };

  return (
    <div className="space-y-2" data-testid="operation-profiles">
      <div>
        <span className="text-sm font-medium text-[color:var(--text-primary)]">Profils par opération</span>
        <p className="text-xs text-[color:var(--text-muted)]">
          Facultatif. Laissez « hérité » pour appliquer les réglages du traitement ci-dessus. Chaque rang peut avoir son propre
          niveau de raisonnement et son plafond de sortie ; un plafond supérieur à la limite d’un modèle lui est ramené
          automatiquement, une combinaison que le modèle n’accepte pas est refusée avant tout appel.
        </p>
      </div>
      {operations.map((op) => {
        const p = profiles[op.operationCode] ?? {};
        const lignes = (plans ?? []).filter((x) => x.operationCode === op.operationCode);
        const propre = Boolean(profiles[op.operationCode]);
        const refus = lignes.some((l) => l.refusal);
        return (
          <details key={op.operationCode} className="rounded-lg border border-[color:var(--border-subtle)]" data-testid={`operation-profile-${op.operationCode}`}>
            <summary className="cursor-pointer px-3 py-2 text-sm text-[color:var(--text-primary)]">
              <span className="font-mono text-xs">{op.operationCode}</span>
              <span className="text-[color:var(--text-muted)]"> · {propre ? 'profil propre' : 'référence du traitement'}</span>
              {refus && <span className="ml-1 text-xs text-[color:var(--text-danger)]">· combinaison refusée</span>}
            </summary>
            <div className="px-3 pb-3 space-y-3">
              <p className="text-xs text-[color:var(--text-muted)]">{op.label}{op.minOutputTokens ? ` · plancher de sortie ${op.minOutputTokens.toLocaleString('fr-FR')}` : ''}{op.imageInput ? ' · entrée image/PDF' : ''}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {SLOTS.map(([, libelle], i) => (
                  <div key={libelle} className="space-y-1.5 min-w-0">
                    <span className="text-xs font-medium text-[color:var(--text-secondary)]">{libelle}</span>
                    <select className={selectClass} aria-label={`${op.operationCode} — raisonnement ${libelle}`}
                      disabled={readOnly || !present[i]}
                      value={p.reasoningByRank?.[i] ?? ''}
                      onChange={(e) => {
                        const arr = [...(p.reasoningByRank ?? [])];
                        arr[i] = e.target.value || null;
                        setOp(op.operationCode, { ...p, reasoningByRank: arr });
                      }}>
                      <option value="">raisonnement hérité</option>
                      {reasoningLevels.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <Input type="number" min={1} inputMode="numeric" aria-label={`${op.operationCode} — plafond de sortie ${libelle}`}
                      placeholder={i === 0 ? `hérité (${entry.maxOutputTokens ?? 'défaut'})` : 'hérité'}
                      disabled={readOnly || !present[i]}
                      value={p.maxOutputTokensByRank?.[i] ?? ''}
                      onChange={(e) => {
                        const arr = [...(p.maxOutputTokensByRank ?? [])];
                        arr[i] = e.target.value === '' ? null : Number(e.target.value);
                        setOp(op.operationCode, { ...p, maxOutputTokensByRank: arr });
                      }}
                      className="bg-[color:var(--bg-input)]" />
                  </div>
                ))}
              </div>
              <label className="block space-y-1 max-w-[260px]">
                <span className="text-xs font-medium text-[color:var(--text-secondary)]">Délai (ms)</span>
                <Input type="number" min={op.minTimeoutMs} max={op.timeoutMs} inputMode="numeric"
                  placeholder={`hérité (${op.timeoutMs})`} disabled={readOnly}
                  value={p.timeoutMs ?? ''}
                  onChange={(e) => setOp(op.operationCode, { ...p, timeoutMs: e.target.value === '' ? null : Number(e.target.value) })}
                  className="bg-[color:var(--bg-input)]" />
                <span className="text-xs text-[color:var(--text-muted)]">Entre {op.minTimeoutMs} et {op.timeoutMs} ms (plafond déclaré).</span>
              </label>

              {lignes.length > 0 && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-[color:var(--text-secondary)]">
                    Profils effectifs{unsaved ? ' (version enregistrée — vos modifications ne sont pas encore prises en compte)' : ''}
                  </span>
                  <ul className="space-y-1 text-xs text-[color:var(--text-primary)]">
                    {lignes.map((l) => (
                      <li key={l.rank} className="break-words">
                        <span className="text-[color:var(--text-muted)]">{l.rank === 0 ? 'Principal' : `Repli ${l.rank}`}</span>{' '}
                        <span className="font-mono">{l.model}</span>
                        {l.refusal ? (
                          <span className="text-[color:var(--text-danger)]"> — refusé avant appel : {l.refusal.message}</span>
                        ) : (
                          <>
                            {' '}— raisonnement {l.reasoning.sent ?? 'défaut du modèle'} ({ORIGINE[l.reasoning.origin] ?? l.reasoning.origin})
                            {' '}· sortie {l.maxOutputTokens.sent?.toLocaleString('fr-FR') ?? 'défaut du modèle'} ({ORIGINE[l.maxOutputTokens.origin] ?? l.maxOutputTokens.origin}
                            {l.adaptations.some((a) => a.reason === 'MODEL_OUTPUT_LIMIT') ? `, ramené à la limite du modèle ${l.maxOutputTokens.modelLimit?.toLocaleString('fr-FR')}` : ''})
                            {' '}· délai {l.timeoutMs} ms · température {l.temperature.sent ?? 'défaut du modèle'}
                            {l.adaptations.some((a) => a.reason === 'CAPABILITY_UNKNOWN') ? ' · capacité inconnue : réglage non transmis' : ''}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
