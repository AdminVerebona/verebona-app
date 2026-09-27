"use client";
/**
 * Fiche fournisseur — `/fournisseurs/[id]`.
 *
 * Point d'arrivée des cartes « Fournisseur » de l'assistant (OPEN_SUPPLIER),
 * du tiroir fournisseur (« Voir la fiche ») et de la liste `/fournisseurs`.
 * Lecture seule : coordonnées, puis ce qui relie le fournisseur au compte
 * (biens, documents, équipements, échéances). La modification des
 * coordonnées reste dans le tiroir existant.
 *
 * Les droits sont ceux des biens, appliqués côté serveur
 * (`/api/suppliers/[id]/overview`) : un fournisseur d'un autre compte est
 * introuvable ; un bien archivé ou verrouillé par l'offre est listé sans lien.
 */
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Building2, Mail, Phone, Globe, MapPin, FileText, Wrench, CalendarDays, Home, Pencil, AlertTriangle, ChevronRight,
} from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { openDrawer } from '@/lib/drawers';
import { DOCUMENT_TYPE_LABELS } from '@/lib/document-type-constants';
import { SUPPLIERS_ROUTE } from '@/lib/supplier-routes';
import type { SupplierDetail } from '@/services/suppliers/supplier-detail.service';

const SupplierDrawer = dynamic(
  () => import('@/components/suppliers/SupplierDrawer').then((m) => ({ default: m.SupplierDrawer })),
  { ssr: false },
);

const CONTACT_STATUS: Record<string, string> = {
  unverified: 'Coordonnées non vérifiées',
  partially_verified: 'Coordonnées partiellement vérifiées',
  verified: 'Coordonnées vérifiées',
};

const formatDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Sans date';

function Section({ icon: Icon, title, count, children, empty }: {
  icon: React.ElementType; title: string; count: number; children: React.ReactNode; empty: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="w-4 h-4 text-muted-foreground" aria-hidden />
          {title}
          <span className="text-sm font-normal text-muted-foreground">({count})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="divide-y">{children}</ul>}
      </CardContent>
    </Card>
  );
}

/** Ligne cliquable (ou non, si l'objet n'est pas ouvrable). */
function Row({ title, subtitle, onOpen, href, unavailable }: {
  title: string; subtitle?: string | null; onOpen?: () => void; href?: string; unavailable?: boolean;
}) {
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {unavailable
        ? <span className="text-xs text-muted-foreground">Non disponible</span>
        : <ChevronRight className="w-4 h-4 text-muted-foreground" aria-hidden />}
    </>
  );
  const cls = 'flex w-full items-center gap-3 py-2.5 text-left';
  if (unavailable) return <li className={`${cls} opacity-70`} title="Ce bien est archivé ou n’est pas accessible avec votre offre.">{content}</li>;
  if (href) return <li><Link href={href} className={`${cls} hover:bg-muted/40 rounded-md px-1`}>{content}</Link></li>;
  return <li><button type="button" onClick={onOpen} className={`${cls} hover:bg-muted/40 rounded-md px-1`}>{content}</button></li>;
}

export default function SupplierPage() {
  const params = useParams();
  const { setBreadcrumbs } = useBreadcrumb();
  const [data, setData] = useState<SupplierDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [editOpen, setEditOpen] = useState(false);
  const id = String(params.id ?? '');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/suppliers/${encodeURIComponent(id)}/overview`, { credentials: 'include' });
      if (res.status === 404 || res.status === 400) { setState('not_found'); return; }
      if (!res.ok) { setState('error'); return; }
      setData(await res.json());
      setState('ready');
    } catch {
      setState('error');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setBreadcrumbs([
      { label: 'Fournisseurs', href: SUPPLIERS_ROUTE },
      { label: data?.supplier.name ?? 'Fournisseur' },
    ]);
  }, [data, setBreadcrumbs]);

  if (state === 'loading') {
    return (
      <div className="space-y-6 p-4 md:p-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (state !== 'ready' || !data) {
    return (
      <div className="p-4 md:p-6">
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6">
            <AlertTriangle className="w-5 h-5 text-muted-foreground" aria-hidden />
            <p className="font-medium">
              {state === 'not_found' ? 'Ce fournisseur est introuvable dans votre compte.' : 'La fiche n’a pas pu être chargée.'}
            </p>
            <p className="text-sm text-muted-foreground">
              {state === 'not_found'
                ? 'Il a peut-être été supprimé, ou il appartient à un autre compte.'
                : 'Vérifiez votre connexion puis réessayez.'}
            </p>
            <div className="flex gap-2">
              {state === 'error' && <Button size="sm" onClick={() => { setState('loading'); void load(); }}>Réessayer</Button>}
              <Button size="sm" variant="outline" asChild><Link href={SUPPLIERS_ROUTE}>Voir tous les fournisseurs</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { supplier: s, assets, documents, equipments, agendaItems } = data;
  const adresse = [s.addressLine1, s.addressLine2, [s.postalCode, s.city].filter(Boolean).join(' '), s.country]
    .filter((x) => x && String(x).trim()).join(', ');

  return (
    <div className="space-y-6 p-4 md:p-6">
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                <Building2 className="h-5 w-5 text-blue-400" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-bold">{s.name}</h1>
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.status === 'archived' && <Badge variant="secondary">Archivé</Badge>}
                  <Badge variant="outline">{CONTACT_STATUS[s.contactStatus] ?? 'Coordonnées'}</Badge>
                  {data.openReviewCount > 0 && (
                    <Badge variant="outline" className="border-orange-500/40 text-orange-400">
                      {data.openReviewCount} information{data.openReviewCount > 1 ? 's' : ''} à vérifier
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" aria-hidden />
              Modifier les coordonnées
            </Button>
          </div>

          <dl className="mt-6 grid grid-cols-1 gap-4 border-t pt-4 text-sm md:grid-cols-2">
            {s.email && (
              <div className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
                <dt className="sr-only">E-mail</dt><dd><a className="hover:underline" href={`mailto:${s.email}`}>{s.email}</a></dd></div>
            )}
            {s.phone && (
              <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" aria-hidden />
                <dt className="sr-only">Téléphone</dt><dd><a className="hover:underline" href={`tel:${s.phone.replace(/\s+/g, '')}`}>{s.phone}</a></dd></div>
            )}
            {s.website && (
              <div className="flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
                <dt className="sr-only">Site web</dt><dd className="truncate">{s.website}</dd></div>
            )}
            {adresse && (
              <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
                <dt className="sr-only">Adresse</dt><dd>{adresse}</dd></div>
            )}
            {(s.siret || s.siren) && (
              <div><dt className="text-muted-foreground">{s.siret ? 'SIRET' : 'SIREN'}</dt><dd className="font-medium">{s.siret ?? s.siren}</dd></div>
            )}
            {s.vatNumber && <div><dt className="text-muted-foreground">N° de TVA</dt><dd className="font-medium">{s.vatNumber}</dd></div>}
            {s.hasIban && <div><dt className="text-muted-foreground">RIB</dt><dd className="font-medium">Renseigné (visible dans « Modifier les coordonnées »)</dd></div>}
            {!s.email && !s.phone && !s.website && !adresse && (
              <p className="text-muted-foreground md:col-span-2">Aucune coordonnée renseignée pour le moment.</p>
            )}
          </dl>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section icon={Home} title="Biens" count={assets.length} empty="Aucun bien n’est rattaché à ce fournisseur.">
          {assets.map((a) => (
            <Row key={a.id} title={a.name} subtitle={a.city} href={`/assets/${a.id}`} unavailable={!a.available} />
          ))}
        </Section>

        <Section icon={FileText} title="Documents" count={documents.length} empty="Aucun document n’est rattaché à ce fournisseur.">
          {documents.map((d) => (
            <Row
              key={d.id}
              title={d.title}
              subtitle={[d.documentType ? DOCUMENT_TYPE_LABELS[d.documentType] ?? d.documentType : null, d.documentDate ? formatDate(d.documentDate) : null, d.assetName].filter(Boolean).join(' · ')}
              onOpen={() => openDrawer({ kind: 'document', id: d.id })}
              unavailable={!d.available}
            />
          ))}
        </Section>

        <Section icon={Wrench} title="Équipements" count={equipments.length} empty="Aucun équipement n’est rattaché à ce fournisseur.">
          {equipments.map((e) => (
            <Row
              key={e.id}
              title={e.name}
              subtitle={[e.assetName, e.isPrimary ? 'Fournisseur principal' : null].filter(Boolean).join(' · ')}
              onOpen={() => openDrawer({ kind: 'equipement', id: e.id })}
              unavailable={!e.available}
            />
          ))}
        </Section>

        <Section icon={CalendarDays} title="Échéances" count={agendaItems.length} empty="Aucune échéance n’est liée à ce fournisseur.">
          {agendaItems.map((i) => (
            <Row
              key={i.id}
              title={i.title}
              subtitle={`${formatDate(i.startDate)}${i.manualStatus === 'realise' ? ' · Réalisée' : ''}`}
              onOpen={() => openDrawer({ kind: 'echeance', id: i.id })}
            />
          ))}
        </Section>
      </div>

      <SupplierDrawer
        supplierId={s.id}
        open={editOpen}
        onOpenChange={setEditOpen}
        onUpdated={() => { void load(); }}
        hidePageLink
      />
    </div>
  );
}
