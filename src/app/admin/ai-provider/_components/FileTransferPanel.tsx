"use client";

/**
 * BO › Fournisseur IA › Envoi de fichiers — lot 113R (carte #717).
 *
 * Le test de clé (liste des modèles + génération minimale) n'envoie aucun
 * fichier : il passait alors que chaque analyse T1 échouait sur un HTTP 403
 * de la Files API. Ce bloc donne au PO, sans accès à la base ni au shell :
 *   · « Tester l'envoi d'un fichier au fournisseur » — petit PDF de test,
 *     configuration EFFECTIVE, réponse de Google affichée sans secret
 *     (statut, code, message, raison, détails, identifiant de requête) et
 *     pistes présentées comme des HYPOTHÈSES à confirmer ;
 *   · les documents en attente technique (suspendus, reprise automatique),
 *     l'alerte ouverte et les dernières vérifications conservées.
 * « T1 actif » est une autorisation, pas une preuve : seule une vérification
 * d'envoi réussie libère les documents en attente.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Upload, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import type { AttachmentTransferFailure } from '@/services/ai/gateway/diagnostics/taxonomy';
import { TransferFailureBlock } from '@/components/admin/TransferFailureBlock';

interface Check {
  id: number | null; createdAt: string; origin: 'admin_test' | 'auto_probe'; ok: boolean;
  fileState: string | null; cleanupOk: boolean | null; durationMs: number | null;
  failure: AttachmentTransferFailure | null; localError: string | null; config: Record<string, unknown>;
}
interface StockDoc { fileId: number; accountId: number | null; jobId: number; cause: string; count: number; parked: boolean; historical: boolean; since: string | null; nextAttemptAt: string | null }
interface TransferData {
  config: { endpoint: string; apiVersion: string; keySource: string; credentialId: number | null; envVariable: string | null; envVariablesConsulted: string[] };
  checks: Check[];
  stock: { suspended: number; parked: number; historicalPending: number; documents: StockDoc[] };
  alert: { id: number; message: string; severity: string; lastSeenAt?: string | null } | null;
  policy: { probeMinIntervalMinutes: number; checkRetentionDays: number };
}

const CAUSE_TEXT: Record<string, string> = {
  TRANSFER_ACCESS_DENIED: 'envoi refusé (accès)',
  TRANSFER_UNAVAILABLE: 'envoi momentanément impossible',
};

function keySourceText(c: TransferData['config']): string {
  if (c.keySource === 'BO_ACTIVE_CREDENTIAL') return `clé active du BO (n° ${c.credentialId ?? '?'})`;
  if (c.keySource === 'ENV') return `variable d’environnement ${c.envVariable ?? '?'}`;
  return `aucune clé (BO, ${c.envVariablesConsulted.join(', ')})`;
}

function CheckResult({ c }: { c: Check }) {
  return (
    <div className="space-y-1.5 text-xs text-[color:var(--text-secondary)]" data-testid="file-transfer-check">
      <p className={`flex items-center gap-1.5 font-medium ${c.ok ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-danger)]'}`}>
        {c.ok ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <XCircle className="w-3.5 h-3.5" aria-hidden />}
        {c.ok ? 'Envoi accepté par le fournisseur' : 'Envoi en échec'}
        <span className="font-normal text-[color:var(--text-muted)]">
          — {new Date(c.createdAt).toLocaleString('fr-FR')} · {c.origin === 'admin_test' ? 'test du BO' : 'vérification automatique'}
          {c.durationMs !== null ? ` · ${c.durationMs} ms` : ''}
        </span>
      </p>
      {c.ok && (
        <p>Fichier de test {c.fileState === 'ACTIVE' ? 'accepté et activé' : 'accepté'}{c.cleanupOk === false ? ' (suppression chez le fournisseur non confirmée : expiration automatique sous 48 h)' : ', puis supprimé'}.</p>
      )}
      {c.localError && <p className="text-[color:var(--text-danger)]">{c.localError}</p>}
      {c.failure && <TransferFailureBlock t={c.failure} testId="file-transfer-failure" />}
    </div>
  );
}

export function FileTransferPanel() {
  const [data, setData] = useState<TransferData | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<TransferData>('/api/admin/ai/provider/file-transfer'));
      setErreur(null);
    } catch (e) {
      setErreur((e as { message?: string }).message ?? 'Lecture impossible.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const tester = async () => {
    setBusy(true);
    try {
      const r = await apiClient.post<{ check: Check; reexamination: { released?: number } | null }>('/api/admin/ai/provider/file-transfer', {});
      toast[r.check.ok ? 'success' : 'error'](r.check.ok
        ? `Envoi accepté par le fournisseur${r.reexamination?.released ? ` — ${r.reexamination.released} document(s) remis en analyse` : ''}.`
        : 'Envoi en échec — la réponse du fournisseur est affichée ci-dessous.');
      await load();
    } catch {
      toast.error('Le test d’envoi n’a pas pu être lancé.');
    } finally { setBusy(false); }
  };

  return (
    <div id="envoi-fichiers" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3" data-testid="file-transfer-panel">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="vb-app-section flex items-center gap-2"><Upload className="w-4 h-4" aria-hidden /> Envoi de fichiers au fournisseur</h2>
        <Button size="sm" variant="outline" onClick={tester} disabled={busy} className="min-h-11 sm:min-h-0" data-testid="file-transfer-test">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          Tester l’envoi d’un fichier au fournisseur
        </Button>
      </div>
      <p className="text-xs text-[color:var(--text-muted)]">
        Envoie un petit PDF de test (aucune donnée utilisateur) par le même chemin que l’analyse des documents, avec la clé en service,
        puis le supprime. Aucune génération : aucun coût de modèle. La réponse du fournisseur est conservée sans secret.
        « T1 actif » est une autorisation : seule une vérification d’envoi réussie montre que l’envoi fonctionne.
      </p>
      {erreur && <p className="text-xs text-[color:var(--text-danger)]">{erreur}</p>}
      {data && (
        <>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-[color:var(--text-secondary)]" data-testid="file-transfer-config">
            <dt className="text-[color:var(--text-muted)]">Endpoint</dt><dd className="font-mono break-all">{data.config.endpoint}</dd>
            <dt className="text-[color:var(--text-muted)]">Clé utilisée</dt><dd>{keySourceText(data.config)}</dd>
            <dt className="text-[color:var(--text-muted)]">Vérification automatique</dt>
            <dd>au plus une toutes les {data.policy.probeMinIntervalMinutes} min tant que des documents attendent ; historique conservé {data.policy.checkRetentionDays} jours</dd>
          </dl>

          {data.alert && (
            <p className="text-xs rounded-md border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] p-2" data-testid="file-transfer-alert">
              {data.alert.message}
            </p>
          )}

          <div className="text-xs text-[color:var(--text-secondary)] space-y-1" data-testid="file-transfer-stock">
            <p>
              Documents en attente technique : {data.stock.suspended}
              {data.stock.parked > 0 && <> (dont {data.stock.parked} après épuisement des reprises rapprochées)</>}
              {data.stock.historicalPending > 0 && <> · documents historiques à rattacher au prochain tour : {data.stock.historicalPending}</>}
            </p>
            {data.stock.documents.length > 0 && (
              <ul className="list-disc pl-4">
                {data.stock.documents.slice(0, 20).map((d) => (
                  <li key={d.jobId}>
                    Document {d.fileId} (compte {d.accountId ?? '?'}, travail {d.jobId}) — {CAUSE_TEXT[d.cause] ?? d.cause}
                    {d.historical ? ', historique' : ''} · {d.count} suspension(s){d.parked ? ', attente du rétablissement vérifié' : ''}
                    {d.nextAttemptAt ? ` · prochaine vérification au plus tard le ${new Date(d.nextAttemptAt).toLocaleString('fr-FR')}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.checks.length > 0 ? (
            <div className="space-y-2">
              <CheckResult c={data.checks[0]} />
              {data.checks.length > 1 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-[color:var(--text-muted)]">Vérifications précédentes ({data.checks.length - 1})</summary>
                  <div className="mt-2 space-y-3">{data.checks.slice(1).map((c) => <CheckResult key={c.id ?? c.createdAt} c={c} />)}</div>
                </details>
              )}
            </div>
          ) : (
            <p className="text-xs text-[color:var(--text-muted)]">Aucune vérification d’envoi enregistrée.</p>
          )}
        </>
      )}
    </div>
  );
}
