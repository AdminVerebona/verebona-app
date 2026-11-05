'use client';

/**
 * BO › CGUV — référentiel des versions (lot 102B).
 *
 * L'ancien éditeur de texte n'existe plus : le SITE PUBLIC publie le texte
 * officiel et ses archives immuables. Cet écran LIT le référentiel des
 * versions synchronisé depuis le manifeste public (code, permalien, empreinte
 * SHA-256, substantielle oui / non), montre le dernier état de lecture du
 * manifeste, et propose :
 *   · « Relire le manifeste » (même fonction que la tâche planifiée) ;
 *   · une saisie de secours (manifeste illisible), confirmée ensuite par le
 *     manifeste — jamais une modification : une version est immuable.
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/admin/format';

interface VersionRow {
  id: string;
  versionCode: string;
  status: string;
  source: string;
  permalinkUrl: string;
  sha256: string | null;
  requiresReacceptance: boolean;
  publishedAt: string | null;
  effectiveAt: string | null;
  changeSummary: string;
  acceptances: number;
  hasArchive: boolean;
}

interface SyncState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string;
  lastError: string | null;
  consecutiveFailures: number;
  currentVersionCode: string | null;
  versionsCount: number;
  anomalies: Array<{ kind: string; code: string; detail: string }>;
}

interface Data {
  versions: VersionRow[];
  state: SyncState;
  manifestUrl: string;
  publicUrl: string;
  linksMode?: 'legacy' | 'v2';
}

const STATUS_LABELS: Record<string, string> = {
  CURRENT: 'En vigueur', PUBLISHED: 'Publiée', ARCHIVED: 'Archivée',
};
const SOURCE_LABELS: Record<string, string> = {
  PUBLIC_SITE: 'Site public', BO_MANUAL: 'Saisie BO (à confirmer)', APP_LEGACY: 'Archive application (en attente du site public)',
};
const SYNC_LABELS: Record<string, string> = {
  never: 'Jamais lu', awaiting_public_site: 'En attente du site public (information)', ok: 'Lu avec succès', ok_with_anomalies: 'Lu — écarts signalés', unavailable: 'Indisponible', invalid: 'Invalide',
};

// Lot 104A : refus faute de vérification positive du texte figé.
const ANOMALY_LABELS: Record<string, string> = {
  TEXT_URL_MISSING: 'Version refusée — texte figé non indiqué',
  TEXT_UNAVAILABLE: 'Version refusée — texte figé inaccessible',
  HASH_MISMATCH: 'Version refusée — empreinte différente',
  CURRENT_NOT_VERIFIED: 'Version en vigueur non changée',
  LEGACY_LINK_REFUSED: 'Archive historique non rattachée',
};

const EMPTY_FORM = { code: '', permalink: '', textUrl: '', sha256: '', publishedAt: '', effectiveAt: '', requiresReacceptance: false, makeCurrent: true, changeSummary: '' };

export default function CguvReferentialPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/legal/cguv', { credentials: 'include', cache: 'no-store' });
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/legal/cguv', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(json?.message ?? 'Opération impossible.'); return false; }
      if (body.action === 'sync') {
        const r = json.result;
        setMessage(r?.status === 'ok' || r?.status === 'ok_with_anomalies'
          ? `Manifeste relu : ${r.imported?.length ?? 0} version(s) importée(s)${r.refused?.length ? `, ${r.refused.length} refusée(s) faute de texte vérifié (${r.refused.join(', ')})` : ''}, version en vigueur ${r.current ?? '—'}${r.anomalies?.length ? `, ${r.anomalies.length} écart(s)` : ''}.`
          : r?.status === 'awaiting_public_site'
            ? `Manifeste pas encore publié par le site public (${r?.error ?? ''}). Liens légaux sur les adresses actuelles ; aucune réacceptation exigée.`
            : `Manifeste ${r?.status === 'invalid' ? 'invalide' : 'indisponible'} : ${r?.error ?? 'erreur inconnue'}. Le dernier état connu reste en service.`);
      } else {
        setMessage(`Version ${json.version?.versionCode ?? ''} enregistrée.`);
        setForm(EMPTY_FORM);
      }
      return true;
    } finally {
      setBusy(false);
      void load();
    }
  };

  const s = data?.state;
  return (
    <div className="container mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <div className="space-y-1">
        <h1 className="vb-app-title flex items-center gap-2"><ScrollText className="h-6 w-6" /> CGUV — référentiel des versions</h1>
        <p className="text-sm text-muted-foreground">
          Le texte officiel et ses archives sont publiés par le site public. Ici : les versions connues (code, permalien,
          empreinte, substantielle oui / non) et les preuves qui s’y rattachent. Aucune édition de texte.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="vb-app-section">Manifeste public</h2>
          <Button onClick={() => post({ action: 'sync' })} disabled={busy} size="sm">
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Relire le manifeste
          </Button>
        </div>
        {loading && !data ? (
          <p className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin" /> Chargement…</p>
        ) : data ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2">
            <div><dt className="text-muted-foreground">Adresse lue</dt><dd className="font-mono break-all">{data.manifestUrl}</dd></div>
            <div><dt className="text-muted-foreground">CGUV en vigueur (site public)</dt><dd><a className="underline break-all" href={data.publicUrl} target="_blank" rel="noopener noreferrer">{data.publicUrl}</a></dd></div>
            <div><dt className="text-muted-foreground">Liens légaux de l’application</dt><dd>{data.linksMode === 'v2' ? 'Nouvelles adresses /legal/… du site public' : 'Adresses actuelles du site public (repli, en attendant le manifeste)'}</dd></div>
            <div><dt className="text-muted-foreground">Dernière lecture</dt><dd>{SYNC_LABELS[s?.lastStatus ?? 'never'] ?? s?.lastStatus} · {formatDateTime(s?.lastAttemptAt ?? null)}</dd></div>
            <div><dt className="text-muted-foreground">Dernier succès</dt><dd>{formatDateTime(s?.lastSuccessAt ?? null)}{s && s.consecutiveFailures > 0 ? ` · ${s.consecutiveFailures} échec(s) consécutif(s)` : ''}</dd></div>
            {s?.lastError && <div className="md:col-span-2"><dt className="text-muted-foreground">Erreur</dt><dd className="break-all">{s.lastError}</dd></div>}
            {s && s.anomalies.length > 0 && (
              <div className="md:col-span-2">
                <dt className="text-muted-foreground">Écarts signalés (Supervision)</dt>
                <dd><ul className="list-disc pl-5">{s.anomalies.map((a, i) => <li key={i}><span className="font-mono">{a.code}</span> — {ANOMALY_LABELS[a.kind] ? `${ANOMALY_LABELS[a.kind]} : ` : ''}{a.detail}</li>)}</ul></dd>
              </div>
            )}
          </dl>
        ) : <p className="text-sm text-muted-foreground">Lecture impossible.</p>}
        {message && <p className="text-sm" role="status">{message}</p>}
      </section>

      <section className="rounded-xl border bg-card overflow-hidden">
        <div className="border-b px-4 py-3"><h2 className="vb-app-section">Versions</h2></div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Substantielle</TableHead>
                <TableHead>Publiée le</TableHead>
                <TableHead>Origine</TableHead>
                <TableHead>Empreinte SHA-256</TableHead>
                <TableHead className="text-right">Acceptations</TableHead>
                <TableHead>Permalien</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.versions ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-muted-foreground italic">Aucune version connue.</TableCell></TableRow>
              ) : data!.versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono whitespace-nowrap">{v.versionCode}</TableCell>
                  <TableCell>{STATUS_LABELS[v.status] ?? v.status}</TableCell>
                  <TableCell>{v.requiresReacceptance ? 'Oui — réacceptation' : 'Non'}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(v.publishedAt)}</TableCell>
                  <TableCell>{SOURCE_LABELS[v.source] ?? v.source}</TableCell>
                  <TableCell className="font-mono text-xs break-all max-w-[16rem]">{v.sha256 ?? '—'}</TableCell>
                  <TableCell className="text-right">{v.acceptances}</TableCell>
                  <TableCell>
                    {v.permalinkUrl ? (
                      <a href={v.permalinkUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
                        Ouvrir <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <details className="rounded-xl border bg-card p-4">
        <summary className="cursor-pointer vb-app-section">Saisie de secours (manifeste illisible)</summary>
        <p className="mt-2 text-sm text-muted-foreground">
          À n’utiliser que si le manifeste ne peut pas être lu. Mêmes règles que le manifeste (format AAAA-MM-JJ-vN, lien sur le
          site public, empreinte SHA-256 vérifiée sur les octets du texte figé servi par le site : sans vérification réussie,
          rien n’est enregistré). La décision « substantielle » est figée à l’enregistrement ; la version sera
          confirmée par la prochaine lecture du manifeste (tout écart est signalé).
        </p>
        <form
          className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"
          onSubmit={(e) => { e.preventDefault(); void post({ action: 'manual', ...form, publishedAt: form.publishedAt ? new Date(form.publishedAt).toISOString() : '', effectiveAt: form.effectiveAt ? new Date(form.effectiveAt).toISOString() : null }); }}
        >
          <div className="space-y-1"><Label htmlFor="cg-code">Code</Label><Input id="cg-code" placeholder="2026-10-30-v1" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.trim() })} /></div>
          <div className="space-y-1"><Label htmlFor="cg-date">Publiée le</Label><Input id="cg-date" type="datetime-local" value={form.publishedAt} onChange={(e) => setForm({ ...form, publishedAt: e.target.value })} /></div>
          {/* Lot 111O : date d'entrée en vigueur du manifeste (vide : date de publication). */}
          <div className="space-y-1"><Label htmlFor="cg-eff">En vigueur le (heure de Paris)</Label><Input id="cg-eff" type="datetime-local" value={form.effectiveAt} onChange={(e) => setForm({ ...form, effectiveAt: e.target.value })} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="cg-link">Permalien (site public)</Label><Input id="cg-link" value={form.permalink} onChange={(e) => setForm({ ...form, permalink: e.target.value.trim() })} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="cg-text">Texte figé (fichier .html du site public — vide : permalien + « .html »)</Label><Input id="cg-text" value={form.textUrl} onChange={(e) => setForm({ ...form, textUrl: e.target.value.trim() })} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="cg-sha">Empreinte SHA-256</Label><Input id="cg-sha" className="font-mono" value={form.sha256} onChange={(e) => setForm({ ...form, sha256: e.target.value.trim().toLowerCase() })} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="cg-sum">Résumé des modifications (affiché à la réacceptation)</Label><Input id="cg-sum" value={form.changeSummary} onChange={(e) => setForm({ ...form, changeSummary: e.target.value })} /></div>
          <div className="flex items-center gap-2"><Checkbox id="cg-sub" checked={form.requiresReacceptance} onCheckedChange={(v) => setForm({ ...form, requiresReacceptance: v === true })} /><Label htmlFor="cg-sub" className="font-normal">Modification substantielle (réacceptation obligatoire)</Label></div>
          <div className="flex items-center gap-2"><Checkbox id="cg-cur" checked={form.makeCurrent} onCheckedChange={(v) => setForm({ ...form, makeCurrent: v === true })} /><Label htmlFor="cg-cur" className="font-normal">Version en vigueur</Label></div>
          <div className="md:col-span-2"><Button type="submit" variant="outline" disabled={busy}>Enregistrer la version</Button></div>
        </form>
      </details>
    </div>
  );
}
