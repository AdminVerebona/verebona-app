"use client";
/**
 * Liste des fournisseurs — `/fournisseurs`.
 *
 * Cible de l'action OPEN_SUPPLIERS de l'assistant (« Voir les fournisseurs »)
 * et du lien « Voir tous » des cartes Fournisseur. Recherche par nom ; chaque
 * ligne ouvre la fiche. Lecture par `/api/suppliers` (compte actif, IBAN
 * exclu).
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Building2, ChevronRight, Search } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { supplierHref } from '@/lib/supplier-routes';

interface SupplierRow {
  id: number;
  name: string;
  city: string | null;
  email: string | null;
  phone: string | null;
}

export default function SuppliersPage() {
  const { setBreadcrumbs } = useBreadcrumb();
  const [rows, setRows] = useState<SupplierRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filtre, setFiltre] = useState('');

  useEffect(() => { setBreadcrumbs([{ label: 'Fournisseurs' }]); }, [setBreadcrumbs]);

  useEffect(() => {
    let actif = true;
    fetch('/api/suppliers', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (actif) setRows(Array.isArray(d.suppliers) ? d.suppliers : []); })
      .catch(() => { if (actif) setFailed(true); });
    return () => { actif = false; };
  }, []);

  const visibles = useMemo(() => {
    const q = filtre.trim().toLocaleLowerCase('fr-FR');
    const liste = [...(rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    return q ? liste.filter((s) => `${s.name} ${s.city ?? ''}`.toLocaleLowerCase('fr-FR').includes(q)) : liste;
  }, [rows, filtre]);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-bold">Fournisseurs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Les entreprises et artisans repérés dans vos documents ou ajoutés par vous.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={filtre}
          onChange={(e) => setFiltre(e.target.value)}
          placeholder="Rechercher un fournisseur"
          aria-label="Rechercher un fournisseur"
          className="pl-9"
        />
      </div>

      {failed ? (
        <p className="text-sm text-muted-foreground">La liste n’a pas pu être chargée. Réessayez dans un instant.</p>
      ) : rows === null ? (
        <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : visibles.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          {rows.length === 0
            ? 'Aucun fournisseur pour le moment. Ils apparaissent dès qu’un document en mentionne un.'
            : 'Aucun fournisseur ne correspond à votre recherche.'}
        </CardContent></Card>
      ) : (
        <Card>
          <CardContent className="pt-2">
            <ul className="divide-y">
              {visibles.map((s) => (
                <li key={s.id}>
                  <Link href={supplierHref(s.id)} className="flex items-center gap-3 rounded-md px-1 py-3 hover:bg-muted/40">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-blue-500/10">
                      <Building2 className="h-4 w-4 text-blue-400" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{[s.city, s.email ?? s.phone].filter(Boolean).join(' · ') || 'Aucune coordonnée'}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
