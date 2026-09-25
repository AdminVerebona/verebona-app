'use client';

/**
 * Mon compte → Informations légales — CDC 7 §11.
 *
 * Quatre liens attendus par la spécification : CGVU en vigueur, CGVU acceptées
 * par l'utilisateur, mentions légales, politique de confidentialité.
 *
 * Pour la version acceptée, le §11 impose d'afficher l'identifiant de version,
 * la date d'acceptation, un bouton « Consulter » et un bouton « Télécharger en
 * HTML ». Rien de plus : « il n'est pas nécessaire de créer un coffre
 * contractuel complexe ni une liste détaillée de tous les emails envoyés ».
 */

import { useEffect, useState } from 'react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Button } from '@/components/ui/button';
import { Scale, ExternalLink, Loader2 } from 'lucide-react';
import { publicSiteUrl } from '@/lib/external-urls';

interface AcceptanceItem {
  acceptanceId: string;
  versionCode: string;
  title: string;
  acceptedAt: string;
  context: string;
  permalink: string | null;
  downloadUrl: string;
}

interface CurrentVersion {
  versionCode: string;
  permalink: string;
  effectiveAt: string | null;
}

/** Libellés des contextes du §9, pour ne pas afficher les codes bruts. */
const CONTEXT_LABELS: Record<string, string> = {
  ACCOUNT_CREATION: 'à la création du compte',
  TRIAL_START: 'au démarrage de l’essai',
  PAID_SUBSCRIPTION: 'lors de la souscription',
  VERSION_UPDATE: 'suite à une nouvelle version',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function LegalInformationCard() {
  const [acceptances, setAcceptances] = useState<AcceptanceItem[]>([]);
  const [current, setCurrent] = useState<CurrentVersion | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch('/api/me/legal/acceptances', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { acceptances: [] }))
        .catch(() => ({ acceptances: [] })),
      fetch('/api/legal/cgvu/current', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([mine, currentVersion]) => {
      if (cancelled) return;
      setAcceptances(mine.acceptances ?? []);
      setCurrent(currentVersion);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // La plus récente : c'est celle qui engage l'utilisateur aujourd'hui.
  const latest = acceptances[0];

  return (
    // Tiroir fermé par défaut : les documents restent à un clic.
    <CollapsibleCard
      icon={<Scale className="w-5 h-5" />}
      title="Informations légales"
      description="Consultez les conditions que vous avez acceptées et celles en vigueur."
      contentClassName="space-y-6"
    >
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Chargement…
          </div>
        ) : (
          <>
            {/* ── Version acceptée ─────────────────────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Conditions que vous avez acceptées</h3>

              {latest ? (
                <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2">
                  <div className="text-sm">
                    <span className="font-mono">{latest.versionCode}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      — acceptée le {formatDate(latest.acceptedAt)}{' '}
                      {CONTEXT_LABELS[latest.context] ?? ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={latest.permalink ?? '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="w-4 h-4 mr-1.5" />
                        Consulter
                      </a>
                    </Button>
                    {/* ══════════════════════════════════════════════════
                        BOUTON DE TÉLÉCHARGEMENT RETIRÉ

                        Décision produit. À noter : le §10 du CDC 7 prévoit
                        que l'utilisateur puisse conserver une preuve de la
                        version acceptée. « Consulter » ouvre le permalien,
                        qui reste figé sur cette version — mais l'utilisateur
                        n'a plus de copie locale.

                        La route `downloadUrl` existe toujours côté serveur :
                        rétablir le bouton est une affaire de six lignes.
                        ══════════════════════════════════════════════════ */}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Aucune acceptation enregistrée pour ce compte.
                </p>
              )}

              {/* Historique : utile dès qu'une nouvelle version a été acceptée. */}
              {acceptances.length > 1 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    Voir les {acceptances.length - 1} acceptation
                    {acceptances.length > 2 ? 's' : ''} précédente
                    {acceptances.length > 2 ? 's' : ''}
                  </summary>
                  <ul className="mt-2 space-y-1 pl-4">
                    {acceptances.slice(1).map((a) => (
                      <li key={a.acceptanceId} className="text-muted-foreground">
                        <a
                          href={a.permalink ?? '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono hover:underline"
                        >
                          {a.versionCode}
                        </a>
                        {' — '}
                        {formatDate(a.acceptedAt)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            {/* ── Version en vigueur ───────────────────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Conditions actuellement en vigueur</h3>
              {current ? (
                <p className="text-sm text-muted-foreground">
                  {/* Le numéro de version disparaît ici : il n'apprend rien à
                      qui veut simplement lire les conditions en cours. Il
                      reste dans « Conditions que vous avez acceptées », où il
                      identifie ce qui a été signé. */}
                  <a
                    href={current.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Lire les conditions générales
                  </a>
                  {latest && latest.versionCode !== current.versionCode && (
                    <span className="block mt-1">
                      Une version plus récente que la vôtre est en vigueur. Elle
                      vous sera présentée si son acceptation devient nécessaire.
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Indisponible pour le moment.</p>
              )}
            </section>

            {/* ── Autres documents (§11) ─────────────────────────────────
                Ces deux liens étaient RELATIFS : ils ouvraient
                `app.preprod.verebona.fr/mentions-legales`, qui n'existe pas —
                d'où les 404. Les pages vivent sur la vitrine. */}
            <section className="flex flex-wrap gap-3 text-sm">
              <a
                href={publicSiteUrl('/mentions-legales')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Mentions légales
              </a>
              <a
                href={publicSiteUrl('/confidentialite')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Politique de confidentialité
              </a>
            </section>
          </>
        )}
    </CollapsibleCard>
  );
}
