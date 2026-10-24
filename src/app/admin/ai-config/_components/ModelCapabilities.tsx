'use client';

/**
 * Capacités des modèles — lecture seule — lot 85C (CDC Pilotage IA V2 P4 :
 * CAT-03, BO-06 ; décisions PO 02, 09, 12).
 *
 * Section repliée de Configuration IA (écran existant) : pour chaque modèle
 * connu, la fiche de capacités utilisée par le constructeur de requête unique
 * — raisonnement réglable, température, limites, modalités, paramètres
 * refusés —, la SOURCE et la DATE de chaque information, et la marque
 * « requalification nécessaire » posée sur événement (changement de
 * capacités). Un modèle Preview reste visible pour information seulement.
 * Cartes empilées : même composant en desktop (2 colonnes) et en mobile
 * (1 colonne), aucune table à défilement horizontal.
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';

interface FieldSource { source: 'api' | 'reference' | 'probe'; verifiedAt: string | null; ref?: string | null }
interface Capabilities {
  model: string; family: string | null;
  thinking: { mode: string };
  temperature: { accepted: boolean | null; min: number | null; max: number | null; providerDefault: number | null };
  outputTokenLimit: number | null; inputTokenLimit: number | null;
  modalities: { imageInput: boolean | null; structuredOutput: boolean | null };
  rejected: string[];
  sources: Record<string, FieldSource | undefined>;
}
interface Row {
  model: string; listed: boolean; available: boolean | null; lifecycle: string | null;
  capabilities: Capabilities; thinkingLabel: string; informationOnly: boolean;
  checkedAt: string | null; changedAt: string | null;
  requalificationRequiredAt: string | null; requalificationReason: string | null; qualifiedAt: string | null;
}
interface Change { model: string; detectedAt: string; changes: Array<{ field: string }> | null; requalificationMarked: boolean; trigger: string }
interface Data {
  readAt: string; referencesVersion: string;
  temperatureProfiles: Record<string, { value: number; note: string }>;
  capabilities: Row[]; changes: Change[];
}

const SOURCE: Record<string, string> = { api: 'API Google', reference: 'référence documentée', probe: 'sonde' };
const nb = (v: number | null | undefined) => (v == null ? 'inconnue' : v.toLocaleString('fr-FR'));
const oui = (v: boolean | null) => (v === true ? 'oui' : v === false ? 'non' : 'non établi');

function Src({ s }: { s?: FieldSource }) {
  if (!s) return <span className="text-[color:var(--text-muted)]"> · source : aucune</span>;
  return (
    <span className="text-[color:var(--text-muted)]" title={s.ref ?? undefined}>
      {' '}· {SOURCE[s.source] ?? s.source}{s.verifiedAt ? ` (${s.verifiedAt.length > 10 ? formatDateTime(s.verifiedAt) : s.verifiedAt})` : ''}
    </span>
  );
}

export function ModelCapabilities() {
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Data>('/api/admin/ai/model-capabilities'));
    } catch {
      toast.error('Capacités des modèles indisponibles.');
    }
  }, []);
  const aRequalifier = data?.capabilities.filter((r) => r.requalificationRequiredAt).length ?? 0;

  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
      data-testid="model-capabilities"
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !data) void load(); }}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Capacités des modèles · paramètres acceptés, limites, sources
        {aRequalifier > 0 && <span className="ml-2 text-xs text-[color:var(--text-warning-soft)]">• {aRequalifier} à requalifier</span>}
      </summary>
      {!data ? (
        <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p>
      ) : (
        <div className="px-4 pb-4 space-y-4">
          <p className="text-xs text-[color:var(--text-muted)]">
            Lecture seule ({data.referencesVersion}). Les paramètres réellement envoyés aux modèles — en exécution, en test et
            en qualification — sont construits à partir de ces fiches, jamais d’après le nom du modèle. Une capacité inconnue
            n’est jamais supposée : le réglage n’est pas transmis. Mise à jour chaque jour avec le catalogue ; un changement
            marque le modèle « à requalifier ». Température : réglage technique par famille, non modifiable ici
            ({Object.entries(data.temperatureProfiles).map(([f, p]) => `${f} → ${p.value}`).join(' ; ')}).
          </p>

          <div className="grid gap-3 md:grid-cols-2">
            {data.capabilities.map((r) => {
              const c = r.capabilities;
              return (
                <article key={r.model} data-testid={`capabilities-${r.model}`}
                  className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1.5 text-xs text-[color:var(--text-primary)] min-w-0">
                  <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-mono text-sm break-all">{r.model}</span>
                    {r.informationOnly && <span className="text-[color:var(--text-warning-soft)]">Preview · information seulement (exclu en V1)</span>}
                    {!r.listed && <span className="text-[color:var(--text-muted)]">non listé par la clé active</span>}
                    {r.listed && r.available === false && <span className="text-[color:var(--text-danger)]">retiré</span>}
                  </header>
                  {r.requalificationRequiredAt && (
                    <p role="status" className="text-[color:var(--text-warning-soft)]">
                      Requalification nécessaire depuis le {formatDateTime(r.requalificationRequiredAt)}
                      {r.requalificationReason ? ` — ${r.requalificationReason}` : ''}
                    </p>
                  )}
                  <p>Famille : {c.family ?? 'inconnue'}<Src s={c.sources.family} /></p>
                  <p>Raisonnement : {r.thinkingLabel}<Src s={c.sources.thinking} /></p>
                  <p>
                    Température : {c.temperature.accepted === false ? 'refusée' : c.temperature.accepted ? `acceptée (${c.temperature.min ?? '?'}–${c.temperature.max ?? '?'})` : 'inconnue'}
                    {c.temperature.providerDefault != null ? ` · défaut fournisseur ${c.temperature.providerDefault}` : ''}
                    <Src s={c.sources.temperature} />
                  </p>
                  <p>Sortie max : {nb(c.outputTokenLimit)}<Src s={c.sources.outputTokenLimit} /> · entrée max : {nb(c.inputTokenLimit)}</p>
                  <p>Entrée image/PDF : {oui(c.modalities.imageInput)} · schéma JSON : {oui(c.modalities.structuredOutput)}<Src s={c.sources.imageInput ?? c.sources.structuredOutput} /></p>
                  {c.rejected.length > 0 && (
                    <p className="text-[color:var(--text-danger)] break-words">Paramètres refusés par le modèle : <span className="font-mono">{c.rejected.join(', ')}</span></p>
                  )}
                  <p className="text-[color:var(--text-muted)]">
                    Fiche enregistrée {r.checkedAt ? `le ${formatDateTime(r.checkedAt)}` : 'jamais (modèle non listé)'}
                    {r.changedAt ? ` · modifiée le ${formatDateTime(r.changedAt)}` : ''}
                    {r.qualifiedAt ? ` · qualifiée le ${formatDateTime(r.qualifiedAt)}` : ''}
                  </p>
                </article>
              );
            })}
          </div>

          {data.changes.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="vb-app-subsection">Derniers changements de capacités</h3>
              <ul className="space-y-1 text-xs text-[color:var(--text-primary)]">
                {data.changes.slice(0, 20).map((ch, k) => (
                  <li key={k} className="break-words">
                    {formatDateTime(ch.detectedAt)} · <span className="font-mono">{ch.model}</span> :{' '}
                    {(ch.changes ?? []).map((x) => x.field).join(', ') || 'fiche modifiée'}
                    {ch.requalificationMarked ? ' — requalification marquée' : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </details>
  );
}
