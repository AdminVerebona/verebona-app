'use client';

/**
 * Mon compte → Informations légales — CDC 7 §11 ; lot 102B.
 *
 * Liens : CGUV en vigueur, CGUV acceptées par l'utilisateur (permalien
 * historique de la version acceptée), et les contenus de la rubrique « Légal »
 * du SITE PUBLIC (source juridique unique, `lib/legal/public-legal`).
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
import { CGUV_SHORT_LABEL, legalLinksList } from '@/lib/legal/public-legal';
import { useLegalLinks } from '@/hooks/useLegalLinks';
import { LegalLink } from '@/components/legal/LegalLink';

interface AcceptanceItem {
  acceptanceId: string;
  versionCode: string;
  title: string;
  acceptedAt: string;
  context: string;
  channel?: string;
  /** Permalien historique de la version acceptée (site public ou archive figée). */
  permalinkUrl: string | null;
  sha256: string | null;
  proofStatus?: 'COMPLETE' | 'HISTORIQUE' | 'EN_ATTENTE_SITE_PUBLIC';
}

interface CurrentVersion {
  versionCode: string;
  permalinkUrl: string;
  publicUrl: string;
  effectiveAt: string | null;
}

/** Libellés des contextes, pour ne pas afficher les codes bruts. */
const CONTEXT_LABELS: Record<string, string> = {
  ACCOUNT_CREATION: 'à la création du compte',
  SOCIAL_SIGNUP: 'à la création du compte (Google / Apple)',
  TRIAL_START: 'au démarrage de l’essai',
  PAID_SUBSCRIPTION: 'lors de la souscription',
  VERSION_UPDATE: 'suite à une nouvelle version',
  IMMEDIATE_START_REQUEST: 'avec la demande de démarrage immédiat',
};

const CHANNEL_LABELS: Record<string, string> = {
  WEB: 'sur le web', IOS: 'sur l’application iPhone', ANDROID: 'sur l’application Android', MOBILE: 'sur l’application',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function LegalInformationCard() {
  const legal = useLegalLinks();
  const [acceptances, setAcceptances] = useState<AcceptanceItem[]>([]);
  const [current, setCurrent] = useState<CurrentVersion | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch('/api/me/legal/acceptances', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { acceptances: [] }))
        .catch(() => ({ acceptances: [] })),
      fetch('/api/legal/cguv/current', { credentials: 'include' })
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
      description="Consultez les CGUV que vous avez acceptées et celles en vigueur."
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
              <h3 className="vb-app-subsection">{CGUV_SHORT_LABEL} que vous avez acceptées</h3>

              {latest ? (
                <div className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-2">
                  <div className="text-sm">
                    <span className="font-mono">{latest.versionCode}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      — acceptée le {formatDate(latest.acceptedAt)}{' '}
                      {CONTEXT_LABELS[latest.context] ?? ''}
                      {latest.channel && CHANNEL_LABELS[latest.channel] ? ` ${CHANNEL_LABELS[latest.channel]}` : ''}
                    </span>
                    {latest.proofStatus === 'HISTORIQUE' && (
                      <span className="block text-xs text-muted-foreground mt-1">Acceptation antérieure au nouveau registre (preuve historique).</span>
                    )}
                    {latest.proofStatus === 'EN_ATTENTE_SITE_PUBLIC' && (
                      <span className="block text-xs text-muted-foreground mt-1">Version conservée par Verebona, en attente de sa publication sur le site public.</span>
                    )}
                    {latest.sha256 && (
                      <span className="block text-xs text-muted-foreground mt-1 break-all">Empreinte du texte : <span className="font-mono">{latest.sha256}</span></span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" asChild>
                      {/* Lot 103A : permalien historique EXACT de la version acceptée ;
                          dans l'app, navigateur externe du téléphone. */}
                      <LegalLink
                        href={latest.permalinkUrl}
                        fallbackHref={legal.cguv}
                        target="_blank"
                        data-testid="legal-accepted-version"
                      >
                        <ExternalLink className="w-4 h-4 mr-1.5" />
                        Consulter
                      </LegalLink>
                    </Button>
                    {/* ══════════════════════════════════════════════════
                        BOUTON DE TÉLÉCHARGEMENT RETIRÉ

                        Décision produit. À noter : le §10 du CDC 7 prévoit
                        que l'utilisateur puisse conserver une preuve de la
                        version acceptée. « Consulter » ouvre le permalien,
                        qui reste figé sur cette version — mais l'utilisateur
                        n'a plus de copie locale.

                        Lot 102B : le site public propose l'enregistrement et
                        l'impression de chaque version (permalien).
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
                        <LegalLink
                          href={a.permalinkUrl}
                          fallbackHref={legal.cguv}
                          target="_blank"
                          className="font-mono hover:underline"
                        >
                          {a.versionCode}
                        </LegalLink>
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
              <h3 className="vb-app-subsection">{CGUV_SHORT_LABEL} actuellement en vigueur</h3>
              {current ? (
                <p className="text-sm text-muted-foreground">
                  {/* Le numéro de version disparaît ici : il n'apprend rien à
                      qui veut simplement lire les conditions en cours. Il
                      reste dans « Conditions que vous avez acceptées », où il
                      identifie ce qui a été signé. */}
                  <LegalLink
                    href={current.publicUrl ?? legal.cguv}
                    fallbackHref={legal.cguv}
                    target="_blank"
                    className="text-primary hover:underline"
                  >
                    Lire les CGUV
                  </LegalLink>
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

            {/* ── Rubrique « Légal » du site public (lot 102B) ──────────── */}
            <section className="flex flex-wrap gap-3 text-sm">
              {legalLinksList(legal).filter((l) => l.key !== 'cguv').map((l) => (
                <LegalLink key={l.key} href={l.href} target="_blank" className="text-primary hover:underline">
                  {l.label}
                </LegalLink>
              ))}
            </section>
          </>
        )}
    </CollapsibleCard>
  );
}
