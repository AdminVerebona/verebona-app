'use client';

/**
 * Administration des CGVU — CDC 7 §5, §6 et §19.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CET ÉCRAN N'OFFRE AUCUN MOYEN DE MODIFIER UNE VERSION PUBLIÉE
 *
 * C'est le critère d'acceptation n°13. L'interface ne propose « Modifier » que
 * sur un brouillon ; la publication est présentée comme irréversible et
 * demande une confirmation explicite.
 *
 * L'interface n'est toutefois que la première barrière : le service la refuse
 * aussi, et un déclencheur PostgreSQL la rend impossible même pour un accès
 * direct au moteur. C'est cette redondance qui rend le critère tenable.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Scale, ExternalLink, Loader2, Plus, Upload, Star, ShieldCheck, AlertTriangle,
} from 'lucide-react';

interface Version {
  id: string;
  versionCode: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'CURRENT' | 'ARCHIVED';
  effectiveAt: string | null;
  publishedAt: string | null;
  changeSummary: string;
  requiresReacceptance: boolean;
  permalink: string | null;
  sha256: string | null;
  contentLength: number;
}

interface AuditEntry {
  id: number;
  occurredAt: string;
  actorLabel: string;
  action: string;
  versionCode: string | null;
  result: string;
  details: string | null;
}

const STATUS_STYLES: Record<Version['status'], { label: string; className: string }> = {
  DRAFT: { label: 'Brouillon', className: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  PUBLISHED: { label: 'Publiée', className: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  CURRENT: { label: 'En vigueur', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  ARCHIVED: { label: 'Archivée', className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
};

const ACTION_LABELS: Record<string, string> = {
  DRAFT_CREATED: 'Brouillon créé',
  DRAFT_UPDATED: 'Brouillon modifié',
  PUBLISHED: 'Publication',
  CURRENT_CHANGED: 'Version en vigueur changée',
  ADMIN_DOWNLOAD: 'Téléchargement administrateur',
  INTEGRITY_FAILED: 'Écart d’intégrité',
  FILE_RESTORED: 'Fichier restauré',
  USER_ACCEPTED: 'Acceptation utilisateur',
  CONFIRMATION_EMAIL_SENT: 'Email de confirmation',
};

/** Propose le prochain code libre pour aujourd'hui (§7). */
function suggestVersionCode(versions: Version[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const used = versions
    .filter((v) => v.versionCode.startsWith(today))
    .map((v) => Number(v.versionCode.split('-v')[1] ?? 0));
  return `${today}-v${Math.max(0, ...used) + 1}`;
}

export default function AdminCgvuPage() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({
    versionCode: '',
    changeSummary: '',
    effectiveAt: new Date().toISOString().slice(0, 10),
    bodyHtml: '',
    requiresReacceptance: false,
  });

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/legal/cgvu/versions', { credentials: 'include' });
    if (!response.ok) {
      setError('Chargement impossible.');
      setLoading(false);
      return;
    }
    const data = await response.json();
    setVersions(data.versions ?? []);
    setAudit(data.audit ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openForm = () => {
    setDraft((d) => ({ ...d, versionCode: suggestVersionCode(versions) }));
    setShowForm(true);
  };

  const call = async (url: string, options: RequestInit, successMessage?: string) => {
    setBusy(url);
    setError(null);
    try {
      const response = await fetch(url, { credentials: 'include', ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? 'Opération refusée.');
        return false;
      }
      if (successMessage) console.info(successMessage);
      await load();
      return true;
    } finally {
      setBusy(null);
    }
  };

  const createDraft = async () => {
    const ok = await call('/api/admin/legal/cgvu/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...draft,
        effectiveAt: new Date(`${draft.effectiveAt}T00:00:00Z`).toISOString(),
      }),
    });
    if (ok) {
      setShowForm(false);
      setDraft((d) => ({ ...d, bodyHtml: '', changeSummary: '' }));
    }
  };

  const publish = async (version: Version) => {
    const confirmed = window.confirm(
      `Publier la version ${version.versionCode} ?\n\n` +
      'Cette action est IRRÉVERSIBLE. Le contenu sera figé et ne pourra plus ' +
      'être modifié. Toute correction ultérieure exigera une nouvelle version ' +
      'portant un nouveau code.',
    );
    if (!confirmed) return;

    await call(`/api/admin/legal/cgvu/drafts/${version.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setAsCurrent: false }),
    });
  };

  const setCurrent = async (version: Version) => {
    const confirmed = window.confirm(
      `Faire de ${version.versionCode} la version en vigueur ?\n\n` +
      'Elle sera présentée aux nouveaux utilisateurs. La version actuelle ' +
      'restera accessible par son permalien.',
    );
    if (!confirmed) return;
    await call(`/api/admin/legal/cgvu/versions/${version.id}/set-current`, { method: 'POST' });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Scale className="w-7 h-7" />
            Conditions générales
          </h1>
          <p className="text-muted-foreground mt-1">
            Versions publiées, version en vigueur et journal des opérations.
          </p>
        </div>
        <Button onClick={openForm} disabled={showForm}>
          <Plus className="w-4 h-4 mr-1.5" />
          Nouveau brouillon
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Nouveau brouillon</CardTitle>
            <CardDescription>
              Un brouillon reste librement modifiable. Il ne devient immuable
              qu&apos;à la publication.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="versionCode">Code de version</Label>
                <Input
                  id="versionCode"
                  value={draft.versionCode}
                  onChange={(e) => setDraft({ ...draft, versionCode: e.target.value })}
                  placeholder="2026-07-30-v1"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Format AAAA-MM-JJ-vN. Jamais réutilisable.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="effectiveAt">Entrée en vigueur</Label>
                <Input
                  id="effectiveAt"
                  type="date"
                  value={draft.effectiveAt}
                  onChange={(e) => setDraft({ ...draft, effectiveAt: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="changeSummary">Résumé des modifications</Label>
              <Input
                id="changeSummary"
                value={draft.changeSummary}
                onChange={(e) => setDraft({ ...draft, changeSummary: e.target.value })}
                placeholder="Ce qui change par rapport à la version précédente"
              />
              <p className="text-xs text-muted-foreground">
                Affiché à l&apos;utilisateur lorsqu&apos;une nouvelle acceptation est requise.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bodyHtml">Contenu (HTML structuré)</Label>
              <Textarea
                id="bodyHtml"
                value={draft.bodyHtml}
                onChange={(e) => setDraft({ ...draft, bodyHtml: e.target.value })}
                rows={12}
                className="font-mono text-xs"
                placeholder="<h2>1. Objet</h2>&#10;<p>…</p>"
              />
            </div>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.requiresReacceptance}
                onChange={(e) => setDraft({ ...draft, requiresReacceptance: e.target.checked })}
                className="mt-1"
              />
              <span>
                Modification <strong>substantielle</strong> — une nouvelle acceptation
                sera demandée aux utilisateurs.
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Cette qualification relève de Verebona et doit être validée avant
                  publication (§8.3).
                </span>
              </span>
            </label>

            <div className="flex gap-2">
              <Button onClick={createDraft} disabled={busy !== null}>
                {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
                Créer le brouillon
              </Button>
              <Button variant="outline" onClick={() => setShowForm(false)}>
                Annuler
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
            </div>
          ) : versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune version enregistrée.</p>
          ) : (
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {versions.map((v) => (
                <li key={v.id} className="py-3 flex flex-wrap items-center gap-3">
                  <span className="font-mono text-sm">{v.versionCode}</span>
                  <Badge variant="outline" className={STATUS_STYLES[v.status].className}>
                    {STATUS_STYLES[v.status].label}
                  </Badge>
                  {v.requiresReacceptance && (
                    <Badge variant="outline" className="bg-amber-500/15 text-amber-300 border-amber-500/30">
                      Réacceptation requise
                    </Badge>
                  )}

                  <span className="text-xs text-muted-foreground flex-1 min-w-[12rem]">
                    {v.changeSummary}
                  </span>

                  <div className="flex gap-2">
                    {v.status === 'DRAFT' && (
                      <Button size="sm" onClick={() => publish(v)} disabled={busy !== null}>
                        <Upload className="w-3.5 h-3.5 mr-1" />
                        Publier
                      </Button>
                    )}
                    {(v.status === 'PUBLISHED' || v.status === 'ARCHIVED') && (
                      <Button size="sm" variant="outline" onClick={() => setCurrent(v)} disabled={busy !== null}>
                        <Star className="w-3.5 h-3.5 mr-1" />
                        Mettre en vigueur
                      </Button>
                    )}
                    {v.permalink && (
                      <Button size="sm" variant="outline" asChild>
                        <a href={v.permalink} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="w-3.5 h-3.5 mr-1" />
                          Voir
                        </a>
                      </Button>
                    )}
                  </div>

                  {v.sha256 && (
                    <span
                      className="text-[10px] font-mono text-muted-foreground w-full"
                      title="Empreinte SHA-256 du document publié"
                    >
                      <ShieldCheck className="w-3 h-3 inline mr-1" />
                      {v.sha256.slice(0, 16)}…
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Journal des opérations</CardTitle>
          <CardDescription>Cent dernières entrées.</CardDescription>
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune entrée.</p>
          ) : (
            <ul className="space-y-1 text-xs font-mono">
              {audit.map((entry) => (
                <li
                  key={entry.id}
                  className={entry.result === 'failure' ? 'text-destructive' : 'text-muted-foreground'}
                >
                  {new Date(entry.occurredAt).toLocaleString('fr-FR')} · {entry.actorLabel} ·{' '}
                  {ACTION_LABELS[entry.action] ?? entry.action}
                  {entry.versionCode ? ` · ${entry.versionCode}` : ''}
                  {entry.details ? ` · ${entry.details}` : ''}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
