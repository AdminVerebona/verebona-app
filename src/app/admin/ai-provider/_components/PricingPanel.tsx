"use client";

/**
 * BO › Fournisseur IA › Tarifs — lot 109L (ticket P1 « Tarifs Gemini non
 * reconnus », points A, B et E).
 *
 * État TARIFAIRE séparé du catalogue modèles : dernière lecture de la page
 * officielle (date, URL finale, statut HTTP, format, empreinte, extrait, code
 * d'échec), couverture (connus / non confirmés / inconnus, modèles utilisés
 * sans tarif), par modèle le tarif APPLIQUÉ et sa source (priorité explicite),
 * l'écart avec la page, le retrait vérifiable ; saisie d'un tarif DOCUMENTÉ
 * (source officielle, date, palier, modalité) quand l'automatisation échoue ;
 * historique des changements. Aucun montant n'est accepté sans source.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, History } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';

interface ModelRow {
  model: string; used: boolean; pageStatus: 'KNOWN' | 'STALE' | 'UNKNOWN' | 'NOT_EVALUATED';
  reason: string | null; reasonCode: string | null; pageAmounts: { input: number; output: number } | null;
  thinkingIncluded: boolean | null; confirmedAt: string | null; staleSince: string | null; absentReads: number; canConfirmRetirement: boolean;
  applied: { source: string; sourceLabel: string; verified: boolean; priority: number; inputPerMillion: number; outputPerMillion: number; rowId: number | null; effectiveFrom: string | null; stale: boolean; reference: string | null } | null;
  conflict: boolean;
}
interface SyncLog {
  id: number; started_at: string; finished_at: string | null; status: string; models_found: number; error_message: string | null;
  failure_code?: string | null; page_format?: string | null; page_fingerprint?: string | null; final_url?: string | null; source_url?: string | null;
  http_status?: number | null; content_type?: string | null; page_bytes?: number | null; page_sample?: string | null; causes?: Array<{ model: string; code: string | null; reason: string }>;
}
interface PricingData {
  source: { page: string; redirect: string; read: string };
  lastSync: SyncLog | null; lastSuccessfulSync: SyncLog | null;
  coverage: { known: number; stale: number; unknown: number; usedWithoutPrice: string[]; usedWithStalePrice: string[] };
  models: ModelRow[];
  history: Array<{ id: number; model: string; old_status: string | null; new_status: string; old_input: string | null; new_input: string | null; old_output: string | null; new_output: string | null; reason: string | null; reason_code: string | null; source: string; detected_at: string }>;
  priorityRule: string;
  cache: { loadedAt: string | null; degraded: boolean; size: number; version?: number | null };
}

const STATUS_LABEL: Record<ModelRow['pageStatus'], string> = {
  KNOWN: 'Confirmé par la page', STALE: 'Non confirmé (STALE)', UNKNOWN: 'Inconnu', NOT_EVALUATED: 'Jamais évalué',
};
const fr = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('fr-FR') : '—');

const EMPTY_FORM = { model: '', input: '', output: '', sourceUrl: '', documentDate: '', effectiveFrom: '', validityEvidence: '', note: '', thinking: true, confirm: false };

export function PricingPanel() {
  const [data, setData] = useState<PricingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiClient.get<PricingData>('/api/admin/ai/provider/pricing')); } catch { toast.error('État tarifaire indisponible.'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const sync = async () => {
    setBusy(true);
    try {
      const r = await apiClient.post<{ pricing: { status: string; modelsFound: number; modelsMissing: string[]; modelsStale?: string[]; failureCode?: string } }>('/api/admin/ai/provider/pricing', { action: 'sync' });
      const p = r.pricing;
      toast[p.status === 'completed' ? 'success' : 'warning'](
        p.status === 'failed' ? `Source tarifaire rejetée (${p.failureCode ?? 'échec'}) : tarifs connus conservés, aucun retrait.`
          : `${p.modelsFound} tarif(s) lu(s) · ${p.modelsStale?.length ?? 0} non confirmé(s) · ${p.modelsMissing.length} inconnu(s).`,
      );
    } catch { toast.error('Synchronisation tarifaire en échec : tarifs connus conservés. Détail ci-dessous.'); }
    finally { setBusy(false); load(); }
  };

  const retire = async (model: string) => {
    const note = window.prompt(`Retrait vérifié du tarif de ${model} : motif (au moins 10 caractères)`);
    if (!note || note.trim().length < 10) return;
    setBusy(true);
    try { await apiClient.post('/api/admin/ai/provider/pricing', { action: 'confirm_retirement', model, note }); toast.success('Tarif retiré (vérifié, historisé).'); }
    catch (e) { toast.error((e as Error).message || 'Retrait refusé.'); } finally { setBusy(false); load(); }
  };

  const saveManual = async () => {
    const input = Number(form.input.replace(',', '.'));
    const output = Number(form.output.replace(',', '.'));
    if (!form.confirm) { toast.error('Confirmez le palier Standard payant et la modalité texte / image / PDF.'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/provider/pricing', {
        action: 'manual', model: form.model.trim(), inputPerMillion: input, outputPerMillion: output, currency: 'USD',
        sourceUrl: form.sourceUrl.trim(), documentDate: form.documentDate, ...(form.effectiveFrom ? { effectiveFrom: form.effectiveFrom } : {}),
        ...(form.validityEvidence.trim() ? { validityEvidence: form.validityEvidence.trim() } : {}),
        paidTier: true, tier: 'standard', modality: 'text_image_pdf', thinkingIncluded: form.thinking, note: form.note.trim(),
      });
      toast.success('Tarif documenté enregistré et appliqué (prioritaire, historisé).');
      setForm(EMPTY_FORM);
    } catch (e) { toast.error((e as Error).message || 'Saisie refusée : source et champs obligatoires.'); }
    finally { setBusy(false); load(); }
  };

  if (loading && !data) {
    return <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Tarifs…</div>;
  }
  if (!data) return null;
  const s = data.lastSync;
  const echec = s && (s.status === 'failed' || s.status === 'stale');

  return (
    <div id="tarifs" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
        <div>
          <h2 className="vb-app-section">Tarifs (synchronisation distincte du catalogue modèles)</h2>
          <p className="text-xs text-[color:var(--text-muted)]">{data.priorityRule}</p>
        </div>
        <Button size="sm" variant="outline" onClick={sync} disabled={busy}><RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Synchroniser les tarifs</Button>
      </div>

      <div className={`rounded-lg border p-3 space-y-1 text-xs ${echec ? 'border-[color:var(--border-warning)] bg-[color:var(--bg-warning)]' : 'border-[color:var(--border-subtle)]'}`}>
        <p className="text-sm text-[color:var(--text-primary)] flex items-center gap-1.5">
          {echec ? <AlertTriangle className="w-4 h-4 text-[color:var(--text-warning-soft)]" /> : <CheckCircle2 className="w-4 h-4 text-[color:var(--text-success)]" />}
          Dernière lecture : {s ? `${s.status}${s.failure_code ? ` — ${s.failure_code}` : ''} le ${fr(s.started_at)}` : 'jamais'}
        </p>
        {s?.error_message && <p className="text-[color:var(--text-warning-soft)]">{s.error_message}</p>}
        <p className="text-[color:var(--text-muted)]">
          Page lue : <span className="font-mono">{s?.source_url ?? data.source.read}</span>
          {s?.final_url && s.final_url !== s.source_url && <> → <span className="font-mono">{s.final_url}</span></>}
          {' '}· HTTP {s?.http_status ?? '—'} · {s?.content_type ?? 'type inconnu'} · {s?.page_bytes ?? 0} octets
        </p>
        <p className="text-[color:var(--text-muted)]">
          Format détecté : <strong>{s?.page_format ?? '—'}</strong> · empreinte <span className="font-mono">{s?.page_fingerprint?.slice(0, 16) ?? '—'}</span>
          {data.lastSuccessfulSync && s && data.lastSuccessfulSync.id !== s.id && <> · dernière lecture réussie le {fr(data.lastSuccessfulSync.started_at)}</>}
        </p>
        {s?.page_sample && (
          <details><summary className="cursor-pointer text-[color:var(--accent)]">Début de la page réellement lue</summary>
            <pre className="whitespace-pre-wrap break-all max-h-48 overflow-auto text-[color:var(--text-secondary)]">{s.page_sample}</pre>
          </details>
        )}
        <p className="text-[color:var(--text-muted)]">Cache de cette instance : {data.cache.size} tarif(s), chargé le {fr(data.cache.loadedAt)}{data.cache.degraded ? ' — DÉGRADÉ' : ''} · version partagée {data.cache.version ?? '—'}</p>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        {[['Confirmés', data.coverage.known], ['Non confirmés', data.coverage.stale], ['Inconnus', data.coverage.unknown]].map(([l, v]) => (
          <div key={String(l)} className="rounded-lg border border-[color:var(--border-subtle)] p-2">
            <p className="text-xl font-bold text-[color:var(--text-primary)]">{v}</p><p className="text-xs text-[color:var(--text-muted)]">{l}</p>
          </div>
        ))}
      </div>
      {(data.coverage.usedWithoutPrice.length > 0 || data.coverage.usedWithStalePrice.length > 0) && (
        <p className="text-xs text-[color:var(--text-warning-soft)]">
          {data.coverage.usedWithoutPrice.length > 0 && <>Modèles utilisés SANS tarif (appels non chiffrés) : {data.coverage.usedWithoutPrice.join(', ')}. </>}
          {data.coverage.usedWithStalePrice.length > 0 && <>Modèles utilisés sur un tarif non confirmé : {data.coverage.usedWithStalePrice.join(', ')}.</>}
        </p>
      )}

      <div className="space-y-1.5">
        {data.models.map((m) => (
          <div key={m.model} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm border-b border-[color:var(--border-subtle)] pb-1.5">
            <span className="font-mono flex-1 min-w-[12rem] truncate text-[color:var(--text-primary)]">{m.model}{m.used && <span className="ml-1 text-xs text-[color:var(--text-muted)]">· utilisé</span>}</span>
            <span className={`text-xs ${m.pageStatus === 'KNOWN' ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-warning-soft)]'}`} title={m.reason ?? undefined}>
              {STATUS_LABEL[m.pageStatus]}{m.reasonCode ? ` — ${m.reasonCode}` : ''}{m.staleSince ? ` depuis le ${fr(m.staleSince)}` : ''}
            </span>
            <span className="text-xs text-[color:var(--text-secondary)]">
              {m.applied ? `${m.applied.inputPerMillion} / ${m.applied.outputPerMillion} $ par million · ${m.applied.sourceLabel}${m.applied.verified ? ' (vérifié)' : ''}${m.applied.stale ? ' · non confirmé' : ''}` : 'aucun tarif appliqué : coût non calculable'}
            </span>
            {m.conflict && <span className="text-xs text-[color:var(--text-warning-soft)]">écart avec la page ({m.pageAmounts?.input} / {m.pageAmounts?.output})</span>}
            {m.canConfirmRetirement && <Button size="sm" variant="ghost" onClick={() => retire(m.model)} disabled={busy}>Confirmer le retrait</Button>}
            {m.reason && m.pageStatus !== 'KNOWN' && <p className="basis-full text-xs text-[color:var(--text-muted)]">{m.reason}</p>}
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Saisir un tarif documenté</h3>
        <p className="text-xs text-[color:var(--text-muted)]">
          Quand la lecture automatique échoue. Source officielle Google obligatoire (https), date du document, palier Standard payant et
          modalité texte / image / PDF vérifiés. Une validité antérieure au document exige sa preuve. Tout est historisé.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input placeholder="Modèle exact (ex. gemini-3.5-flash-lite)" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="bg-[color:var(--bg-input)] font-mono" />
          <Input placeholder="Entrée $ / million" inputMode="decimal" value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} className="bg-[color:var(--bg-input)]" />
          <Input placeholder="Sortie $ / million" inputMode="decimal" value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} className="bg-[color:var(--bg-input)]" />
          <Input placeholder="URL de la source officielle" value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} className="bg-[color:var(--bg-input)] sm:col-span-3" />
          <label className="text-xs text-[color:var(--text-muted)]">Date du document<Input type="date" value={form.documentDate} onChange={(e) => setForm({ ...form, documentDate: e.target.value })} className="bg-[color:var(--bg-input)]" /></label>
          <label className="text-xs text-[color:var(--text-muted)]">Valable depuis (facultatif)<Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} className="bg-[color:var(--bg-input)]" /></label>
          <Input placeholder="Preuve de la validité antérieure (si besoin)" value={form.validityEvidence} onChange={(e) => setForm({ ...form, validityEvidence: e.target.value })} className="bg-[color:var(--bg-input)] self-end" />
          <Input placeholder="Note (au moins 10 caractères)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="bg-[color:var(--bg-input)] sm:col-span-3" />
        </div>
        <label className="flex items-center gap-2 text-xs text-[color:var(--text-secondary)]">
          <input type="checkbox" checked={form.thinking} onChange={(e) => setForm({ ...form, thinking: e.target.checked })} /> Sortie « including thinking tokens »
        </label>
        <label className="flex items-center gap-2 text-xs text-[color:var(--text-secondary)]">
          <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} /> Je confirme : Gemini Developer API, palier Standard payant, même prix texte / image / PDF, devise USD
        </label>
        <Button size="sm" onClick={saveManual} disabled={busy || !form.model || !form.input || !form.output || !form.sourceUrl || !form.documentDate || form.note.trim().length < 10}>Enregistrer le tarif documenté</Button>
      </div>

      <div>
        <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}><History className="w-3.5 h-3.5 mr-1.5" /> Historique des changements ({data.history.length})</Button>
        {showHistory && (
          <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5 mt-1 max-h-64 overflow-auto">
            {data.history.map((h) => (
              <li key={h.id}>{fr(h.detected_at)} · <span className="font-mono">{h.model}</span> · {h.old_status ?? '—'} → {h.new_status}
                {h.new_input !== null && ` · ${h.old_input ?? '—'}/${h.old_output ?? '—'} → ${h.new_input}/${h.new_output} $`}{h.reason_code ? ` · ${h.reason_code}` : ''}{h.reason ? ` · ${h.reason}` : ''} · {h.source}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
