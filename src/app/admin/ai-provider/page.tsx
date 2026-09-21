"use client";

/**
 * Admin — Fournisseur IA — CDC BO IA SCR-10, WF-21.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PARCOURS EST UNE SÉQUENCE, ET L'ÉCRAN LE MONTRE
 *
 * Saisir, tester, activer. Le WF-21 interdit de sauter une étape, et l'écran ne
 * se contente pas de le vérifier côté serveur : le bouton d'activation reste
 * inerte tant que le test n'a pas réussi, et il dit pourquoi.
 *
 * Un bouton qui échoue quand on le presse apprend la règle par l'échec. Un
 * bouton qui explique ce qui manque l'apprend sans rien casser.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉTAIL DU TEST EST AFFICHÉ, PAS RÉSUMÉ
 *
 * Authentification, catalogue, génération : trois vérifications qui échouent
 * séparément et appellent trois gestes différents. « Test échoué » enverrait
 * chercher au hasard ; le message du fournisseur, lui, dit souvent exactement
 * ce qui ne va pas.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CLÉ N'APPARAÎT QUE SI ON LA DEMANDE
 *
 * Le SCR-10 l'autorise en clair. L'afficher d'emblée la ferait entrer dans
 * toute capture d'écran et tout partage de session. Elle reste en aperçu, et
 * « Afficher » est un geste.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Loader2, RefreshCw, KeyRound, Eye, CheckCircle2, XCircle, ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { apiClient } from '@/lib/api-client';

interface Credential {
  id: number;
  status: 'CANDIDATE' | 'ACTIVE' | 'RETIRED';
  preview: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestDetail: {
    authenticated: boolean; modelsListed: number | null;
    generationOk: boolean; model: string | null; error?: string;
  } | null;
  createdAt: string;
  activatedAt: string | null;
}

interface CatalogEntry {
  model: string; priced: boolean; verified: boolean;
  inputPerMillion: number; outputPerMillion: number;
}

interface ProviderData {
  credentials: Credential[];
  catalog: CatalogEntry[];
  catalogLoadedAt: string | null;
  catalogStale: boolean;
}

function TestReport({ c }: { c: Credential }) {
  if (!c.lastTestAt) {
    return (
      <p className="text-xs text-[color:var(--text-muted)]">
        Jamais testée. Une clé doit passer un test réussi avant d&apos;être activée.
      </p>
    );
  }

  const d = c.lastTestDetail;
  const quand = new Date(c.lastTestAt).toLocaleString('fr-FR');

  return (
    <div className="space-y-1">
      <p className={`text-xs flex items-center gap-1.5 ${c.lastTestOk ? 'text-emerald-500' : 'text-red-400'}`}>
        {c.lastTestOk ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
        Test du {quand}
      </p>
      {d && (
        <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5 pl-4">
          <li>{d.authenticated ? '✓' : '✗'} Clé reconnue par le fournisseur</li>
          <li>
            {d.modelsListed !== null ? '✓' : '✗'} Catalogue accessible
            {d.modelsListed !== null && ` — ${d.modelsListed} modèles`}
          </li>
          <li>
            {d.generationOk ? '✓' : '✗'} Génération sur {d.model ?? 'le modèle testé'}
          </li>
        </ul>
      )}
      {d?.error && <p className="text-xs text-red-400 pl-4">{d.error}</p>}
    </div>
  );
}

export default function AiProviderPage() {
  const [data, setData] = useState<ProviderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [revealed, setRevealed] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setErreur(null);
    try {
      setData(await apiClient.get<ProviderData>('/api/admin/ai/provider'));
    } catch (e) {
      // Message ET code du serveur. Le code — VERSION_NOT_FOUND,
      // CONFIG_OPERATION_FAILED — est stable et cherchable dans le dépôt ;
      // le message seul obligerait à ouvrir les outils de développement.
      const err = e as { message?: string; code?: string; status?: number };
      setErreur([err.message, err.code && `(${err.code}${err.status ? ` — ${err.status}` : ''})`]
        .filter(Boolean).join(' ') || null);
      toast.error('Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addKey = async () => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/provider', { secret: newKey.trim() });
      setNewKey('');
      toast.success('Clé enregistrée comme candidate. Testez-la avant de l’activer.');
      await load();
    } catch {
      toast.error('La clé n’a pas pu être enregistrée. Vérifiez qu’elle est complète.');
    } finally { setBusy(false); }
  };

  const test = async (id: number) => {
    setBusy(true);
    try {
      const r = await apiClient.post<{ ok: boolean }>(`/api/admin/ai/provider/${id}/test`, {});
      toast[r.ok ? 'success' : 'error'](
        r.ok ? 'Test réussi' : 'Test échoué — le détail est affiché sous la clé.',
      );
      await load();
    } catch {
      toast.error('Le test n’a pas pu être lancé.');
    } finally { setBusy(false); }
  };

  const activate = async (id: number) => {
    setBusy(true);
    try {
      await apiClient.post(`/api/admin/ai/provider/${id}/activate`, {});
      toast.success('Clé activée');
      await load();
    } catch {
      // Le serveur refuse si le test n'est pas concluant, et conserve l'ancienne
      // clé : le message le dit, pour qu'on ne craigne pas une coupure.
      toast.error('Activation refusée. La clé actuelle reste en service.');
      await load();
    } finally { setBusy(false); }
  };

  const reveal = async (id: number) => {
    try {
      const r = await apiClient.post<{ secret: string }>(`/api/admin/ai/provider/${id}/reveal`, {});
      setRevealed((s) => ({ ...s, [id]: r.secret }));
    } catch {
      toast.error('La clé n’a pas pu être affichée.');
    }
  };

  if (erreur) {
    return <EcranEnErreur titre="Fournisseur indisponible" message={erreur} onRetry={load} />;
  }

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-[color:var(--text-muted)]">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
      </div>
    );
  }

  const active = data.credentials.find((c) => c.status === 'ACTIVE');
  const candidates = data.credentials.filter((c) => c.status === 'CANDIDATE');

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Fournisseur IA</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Connexion Gemini de cet environnement et modèles utilisables.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={busy}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
        </Button>
      </div>

      {/* Clé active */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-500" /> Clé en service
        </h2>

        {!active ? (
          <p className="text-sm text-[color:var(--text-muted)]">
            Aucune clé enregistrée : l&apos;application utilise celle des variables
            d&apos;environnement. Enregistrez-en une ci-dessous pour la gérer depuis cet écran.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <code className="text-sm text-[color:var(--text-primary)] font-mono">
                {revealed[active.id] ?? active.preview}
              </code>
              {!revealed[active.id] && (
                <Button size="sm" variant="ghost" onClick={() => reveal(active.id)}>
                  <Eye className="w-3.5 h-3.5 mr-1.5" /> Afficher
                </Button>
              )}
              <span className="text-xs text-[color:var(--text-muted)]">
                active depuis le {active.activatedAt
                  ? new Date(active.activatedAt).toLocaleDateString('fr-FR') : '—'}
              </span>
            </div>
            <TestReport c={active} />
            <Button size="sm" variant="outline" onClick={() => test(active.id)} disabled={busy}>
              Tester à nouveau
            </Button>
          </>
        )}
      </div>

      {/* Nouvelle clé */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> Remplacer la clé
        </h2>
        <p className="text-xs text-[color:var(--text-muted)]">
          La nouvelle clé est enregistrée sans rien changer. Elle ne remplacera
          l&apos;actuelle qu&apos;après un test réussi.
        </p>
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="Clé du fournisseur"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="bg-[color:var(--bg-input)] font-mono"
          />
          <Button size="sm" onClick={addKey} disabled={busy || newKey.trim().length < 20}>
            Enregistrer
          </Button>
        </div>
      </div>

      {/* Candidates — saisir, tester, activer */}
      {candidates.map((c) => (
        <div key={c.id}
          className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-xs px-2 py-0.5 rounded-full border border-amber-500/20 bg-amber-500/10 text-amber-500">
              Candidate
            </span>
            <code className="text-sm font-mono text-[color:var(--text-primary)]">
              {revealed[c.id] ?? c.preview}
            </code>
            {!revealed[c.id] && (
              <Button size="sm" variant="ghost" onClick={() => reveal(c.id)}>
                <Eye className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>

          <TestReport c={c} />

          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => test(c.id)} disabled={busy}>
              Tester la connexion
            </Button>
            <Button size="sm" onClick={() => activate(c.id)} disabled={busy || c.lastTestOk !== true}>
              Activer
            </Button>
            {c.lastTestOk !== true && (
              <span className="text-xs text-[color:var(--text-muted)] self-center">
                {c.lastTestAt
                  ? 'Le dernier test a échoué : corrigez la clé ou testez à nouveau.'
                  : 'Un test réussi est nécessaire avant l’activation.'}
              </span>
            )}
          </div>
        </div>
      ))}

      {/* Catalogue */}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Modèles</h2>
          <span className="text-xs text-[color:var(--text-muted)]">
            {data.catalogLoadedAt
              ? `dernière actualisation le ${new Date(data.catalogLoadedAt).toLocaleString('fr-FR')}`
              : 'jamais actualisé'}
            {data.catalogStale && ' — vision dégradée'}
          </span>
        </div>

        <div className="space-y-1.5">
          {data.catalog.map((m) => (
            <div key={m.model} className="flex items-center gap-3 text-sm">
              <span className="text-[color:var(--text-primary)] font-mono flex-1 truncate">
                {m.model}
              </span>
              <span className="text-xs text-[color:var(--text-muted)]">
                {m.inputPerMillion} / {m.outputPerMillion} $ par million
              </span>
              {!m.priced && (
                <span className="text-xs text-amber-500">sans tarif en base</span>
              )}
              {m.priced && !m.verified && (
                <span className="text-xs text-[color:var(--text-muted)]">tarif public</span>
              )}
            </div>
          ))}
        </div>

        <p className="text-xs text-[color:var(--text-muted)]">
          Le catalogue n&apos;est pas actualisé automatiquement. Un modèle sans tarif
          empêche de valider une version qui l&apos;utilise.
        </p>
      </div>
    </div>
  );
}
