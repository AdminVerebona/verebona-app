'use client';

/**
 * Refus de lancement d'analyse — lot 113U (carte Trello #720 « Analyse T1 ko »).
 *
 * Chaque réponse non aboutie du lancement d'une analyse depuis le tiroir du
 * document (Web, iOS, Android) : référence d'incident affichée à
 * l'utilisateur, code et catégorie, document (identifiant et métadonnées,
 * jamais le nom), compte, utilisateur, origine, statut HTTP, statut du
 * document au moment du refus et prochaine tentative. Sans SQL, le PO
 * retrouve la cause exacte d'un « Impossible de lancer l'analyse » par la
 * référence de la capture, ou par le numéro du document.
 *
 * Une carte, une colonne sur mobile, filtres en grille à partir de `sm`,
 * composants et jetons existants seulement (charte Sérénité).
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';

interface Item {
  id: number; createdAt: string; incidentRef: string; source: 'server' | 'client'; code: string; category: string; level: 'info' | 'error';
  httpStatus: number | null; assetFileId: number | null; accountId: number | null; userId: number | null; client: string | null;
  appVersion: string | null; processingStatus: string | null; nextAttemptAt: string | null; detail: Record<string, string | number | boolean>;
  documentType: string | null; fileExtension: string | null; uploadedAt: string | null; analysisState: string | null;
  accountName: string | null; userEmail: string | null;
}

/** Libellés des catégories (lisibles, jamais le code seul). */
export const CATEGORY_LABEL: Record<string, string> = {
  SESSION: 'Session expirée ou absente', MFA: 'Double authentification exigée', CGUV: 'Conditions d’utilisation à accepter',
  APP_UPDATE: 'Application à mettre à jour', ACCESS: 'Accès refusé (compte, droits, origine)', PLAN: 'Offre / abonnement',
  NOT_FOUND: 'Document introuvable', IN_PROGRESS: 'Déjà pris en charge (file, attente technique, plafond)',
  UNAVAILABLE: 'Service momentanément indisponible', NETWORK: 'Réseau (côté appareil)', ANALYSIS: 'Analyse lancée puis non aboutie',
  UNKNOWN: 'Cause inconnue (panne inattendue)',
};
const SOURCE_LABEL: Record<string, string> = { server: 'serveur (flux de la route)', client: 'appareil (réponse HTTP ou réseau)' };
const dt = (v: string | null) => (v ? new Date(v).toLocaleString('fr-FR') : '—');

function Row({ it }: { it: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-[color:var(--border-subtle)] p-3 min-w-0" data-testid="launch-refusal-row">
      <button type="button" className="w-full text-left flex items-start justify-between gap-2 min-h-11 sm:min-h-0" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="text-xs break-words">
          <span className="font-medium">{it.incidentRef}</span>
          <span className="text-[color:var(--text-secondary)]"> · {dt(it.createdAt)} · {CATEGORY_LABEL[it.category] ?? it.category}</span>
          <span className="text-[color:var(--text-muted)]"> · code {it.code}{it.httpStatus ? ` · HTTP ${it.httpStatus}` : ''} · document {it.assetFileId ?? '—'} · {it.client ?? '—'}</span>
        </span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <dl className="mt-2 grid gap-1 sm:grid-cols-2 text-xs">
          {([
            ['Origine du constat', SOURCE_LABEL[it.source] ?? it.source],
            ['Niveau', it.level === 'info' ? 'information (rien à faire)' : 'erreur affichée'],
            ['Compte', it.accountId ? `${it.accountId}${it.accountName ? ` · ${it.accountName}` : ''}` : '—'],
            ['Utilisateur', it.userId ? `${it.userId}${it.userEmail ? ` · ${it.userEmail}` : ''}` : '—'],
            ['Appareil', `${it.client ?? '—'}${it.appVersion ? ` · version ${it.appVersion}` : ''}`],
            ['Document', it.assetFileId ? `${it.assetFileId} · ${it.documentType ?? 'type à compléter'}${it.fileExtension ? ` · .${it.fileExtension}` : ''} · ajouté ${dt(it.uploadedAt)}` : '—'],
            ['État actuel du document', it.analysisState ?? '—'],
            ['Statut au moment du refus', it.processingStatus ?? '—'],
            ['Prochaine tentative', dt(it.nextAttemptAt)],
            ['Détail', Object.keys(it.detail).length ? Object.entries(it.detail).map(([k, v]) => `${k} : ${v}`).join(' · ') : '—'],
          ] as Array<[string, string]>).map(([k, v]) => (
            <div key={k} className="min-w-0 break-words">
              <dt className="inline text-[color:var(--text-secondary)]">{k} : </dt>
              <dd className="inline text-[color:var(--text-muted)]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function LaunchRefusalsPanel({ initialRef, initialDocument }: { initialRef?: string | null; initialDocument?: number | null }) {
  const [ref, setRef] = useState(initialRef ?? '');
  const [doc, setDoc] = useState(initialDocument ? String(initialDocument) : '');
  const [account, setAccount] = useState('');
  const [data, setData] = useState<{ available: boolean; items: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const q = new URLSearchParams();
      if (ref.trim()) q.set('ref', ref.trim());
      if (doc.trim()) q.set('document', doc.trim());
      if (account.trim()) q.set('account', account.trim());
      setData(await apiClient.get(`/api/admin/ai/launch-refusals?${q.toString()}`));
    } catch {
      setError('Chargement des refus de lancement impossible.');
    } finally {
      setBusy(false);
    }
  }, [ref, doc, account]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3 min-w-0" data-testid="launch-refusals-panel">
      <div>
        <h2 className="vb-app-section">Refus de lancement d’analyse</h2>
        <p className="text-xs text-[color:var(--text-secondary)]">
          Lancements depuis le tiroir du document restés sans analyse : cause exacte, document, compte, appareil.
          La référence (AN-…) est celle affichée à l’utilisateur.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Input placeholder="Référence AN-…" value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Référence d’incident" />
        <Input placeholder="N° du document" inputMode="numeric" value={doc} onChange={(e) => setDoc(e.target.value)} aria-label="Numéro du document" />
        <Input placeholder="N° du compte" inputMode="numeric" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Numéro du compte" />
        <Button size="sm" variant="outline" onClick={load} disabled={busy}>
          <Search className="w-3.5 h-3.5 mr-1.5" aria-hidden /> Rechercher
        </Button>
      </div>
      {error && <p className="text-xs text-[color:var(--text-danger)]">{error}</p>}
      {data && !data.available && (
        <p className="text-xs text-[color:var(--text-muted)]">Journal non disponible : la migration 1550 n’est pas encore appliquée.</p>
      )}
      {data?.available && data.items.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucun refus pour ces critères.</p>}
      {data?.available && data.items.length > 0 && (
        <ul className="space-y-2">{data.items.map((it) => <Row key={it.id} it={it} />)}</ul>
      )}
    </section>
  );
}
