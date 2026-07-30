"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Eye, Pencil, Trash } from "lucide-react";
import { toast } from "sonner";

// Types aligned with API shape
interface SystemLogo {
  id: number;
  code: string;
  label: string;
  description: string | null;
  logoType: "WEB_ANIMATED" | "EMAIL_STATIC" | "PDF_STATIC" | "SVG" | "PNG" | string;
  contentType: string; // e.g. "text/html", "image/svg+xml", "image/png"
  logoContent: string;
  width: number;
  height: number;
  isActive: boolean;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ApiListResponse {
  data: SystemLogo[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const SystemLogosClient = () => {
  const [logos, setLogos] = useState<SystemLogo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  // New dialog states
  const [createOpen, setCreateOpen] = useState(false);
  const [editLogo, setEditLogo] = useState<SystemLogo | null>(null);
  const [deleteLogo, setDeleteLogo] = useState<SystemLogo | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const selected = useMemo(() => logos.find(l => l.id === openId) || null, [openId, logos]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/admin/system-logos?limit=100&page=1`, {
      credentials: 'include',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `Erreur ${res.status}`);
        }
        const json: ApiListResponse = await res.json();
        setLogos(json.data || []);
      } catch (e: any) {
        setError(e?.message || "Une erreur est survenue");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const ratioFromSize = (w?: number, h?: number) => {
    if (!w || !h || h === 0) return 16 / 9;
    return Math.max(1, Math.min(3, w / h));
  };

  const PreviewBox = ({ logo }: { logo: SystemLogo }) => {
    const ratio = ratioFromSize(logo.width, logo.height);

    // Decide renderer by contentType
    const isHTML = logo.contentType?.includes("text/html");
    const isSVG = logo.contentType?.includes("svg");
    const isPNG = logo.contentType?.includes("png");
    const isImage = logo.contentType?.startsWith("image/");

    // For images like PNG, expect base64 or data URI content
    const imageSrc = isImage && !isSVG && !isHTML
      ? (logo.logoContent.startsWith("data:")
          ? logo.logoContent
          : `data:${logo.contentType};base64,${logo.logoContent}`)
      : undefined;

    // Build a sandboxed iframe document for HTML logos to fully contain layout/positioning
    const htmlSrcDoc = isHTML
      ? `<!DOCTYPE html><html><head><meta charset=\"utf-8\" />
          <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
          <style>
            html,body{margin:0;padding:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;background:transparent}
            *{max-width:100%;max-height:100%;}
          </style>
        </head><body>${logo.logoContent}</body></html>`
      : undefined;

    return (
      <div className="w-full">
        <div className="text-sm text-[color:var(--text-muted)] mb-3">
          Type: <Badge variant="outline" className="align-middle">{logo.logoType}</Badge>
          <span className="ml-2">MIME: {logo.contentType}</span>
          <span className="ml-2">{logo.width}×{logo.height}</span>
        </div>

        <div
          data-logo-preview
          className="relative mx-auto w-full max-w-full overflow-hidden rounded-md border bg-[color:var(--bg-card)] shadow-relief-md"
          style={{
            height: "320px",
          }}
        >
          {/* Center content without absolute wrapper and avoid direct div child to bypass global scaling rules */}
          <section className="flex h-full w-full items-center justify-center p-4">
            {isHTML && htmlSrcDoc && (
              <iframe
                title={logo.label}
                srcDoc={htmlSrcDoc}
                sandbox="allow-same-origin"
                className="h-full w-full border-0"
              />
            )}

            {isSVG && (
              // Inline SVG content wrapped in span to avoid global div scale rule
              <span
                className="block max-w-full max-h-full"
                 
                dangerouslySetInnerHTML={{ __html: logo.logoContent }}
              />
            )}

            {imageSrc && (
              <img
                src={imageSrc}
                alt={logo.label}
                className="block max-h-full max-w-full object-contain"
              />
            )}

            {!isHTML && !isSVG && !imageSrc && (
              <div className="text-center text-sm text-[color:var(--text-muted)]">
                Aperçu non supporté pour ce contentType
              </div>
            )}
          </section>
        </div>

        <p className="mt-3 text-xs text-[color:var(--text-muted)]">
          L'aperçu est limité à 320px de hauteur et centré. Le contenu est contenu dans un iframe sandbox pour éviter tout débordement.
        </p>
      </div>
    );
  };

  // Handlers
  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      setCreateLoading(true);
      const form = new FormData(e.currentTarget);
      const payload = {
        code: String(form.get("code") || "").trim(),
        label: String(form.get("label") || "").trim(),
        description: String(form.get("description") || "").trim() || null,
        logoType: String(form.get("logoType") || "SVG"),
        contentType: String(form.get("contentType") || "image/svg+xml"),
        logoContent: String(form.get("logoContent") || ""),
        width: Number(form.get("width") || 0),
        height: Number(form.get("height") || 0),
        isActive: form.get("isActive") === "on",
        version: Number(form.get("version") || 1),
      };
      const res = await fetch("/api/admin/system-logos", {
      credentials: 'include',
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Création échouée");
      setLogos(prev => [data as SystemLogo, ...prev]);
      setCreateOpen(false);
      toast.success("Logo créé avec succès");
    } catch (err: any) {
      toast.error(err?.message || "Impossible de créer le logo");
    } finally {
      setCreateLoading(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editLogo) return;
    try {
      setUpdateLoading(true);
      const form = new FormData(e.currentTarget);
      const payload: any = {
        label: String(form.get("label") || "").trim(),
        description: String(form.get("description") || "").trim() || null,
        logoType: String(form.get("logoType") || editLogo.logoType),
        contentType: String(form.get("contentType") || editLogo.contentType),
        logoContent: String(form.get("logoContent") || editLogo.logoContent),
        width: Number(form.get("width") || editLogo.width),
        height: Number(form.get("height") || editLogo.height),
        isActive: form.get("isActive") === "on",
        version: Number(form.get("version") || editLogo.version || 1),
      };
      const res = await fetch(`/api/admin/system-logos?id=${editLogo.id}`, {
      credentials: 'include',
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Mise à jour échouée");
      setLogos(prev => prev.map(l => (l.id === (data as SystemLogo).id ? (data as SystemLogo) : l)));
      setEditLogo(null);
      toast.success("Logo mis à jour");
    } catch (err: any) {
      toast.error(err?.message || "Impossible de mettre à jour le logo");
    } finally {
      setUpdateLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteLogo) return;
    try {
      setDeleteLoading(true);
      if (deleteConfirm !== String(deleteLogo.id)) {
        toast.error("Veuillez saisir l'ID pour confirmer");
        return;
      }
      const res = await fetch(`/api/admin/system-logos?id=${deleteLogo.id}`, {
      credentials: 'include',
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmId: deleteLogo.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Suppression échouée");
      setLogos(prev => prev.filter(l => l.id !== deleteLogo.id));
      setDeleteLogo(null);
      setDeleteConfirm("");
      toast.success("Logo supprimé");
    } catch (err: any) {
      toast.error(err?.message || "Impossible de supprimer le logo");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <Card className="shadow-relief-md">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>System Logos</CardTitle>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Ajouter un logo</Button>
            </DialogTrigger>
            <DialogContent className="w-[92vw] max-w-[820px] max-h-[88vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Ajouter un logo</DialogTitle>
                <DialogDescription>Créez un nouveau logo système.</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm mb-1">Code</label>
                    <input name="code" required className="w-full rounded-md border bg-transparent px-3 py-2" placeholder="ex: APP_HEADER" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Libellé</label>
                    <input name="label" required className="w-full rounded-md border bg-transparent px-3 py-2" placeholder="Nom lisible" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm mb-1">Description</label>
                    <input name="description" className="w-full rounded-md border bg-transparent px-3 py-2" placeholder="Optionnel" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Type</label>
                    <select name="logoType" defaultValue="SVG" className="w-full rounded-md border bg-transparent px-3 py-2">
                      <option value="WEB_ANIMATED">WEB_ANIMATED</option>
                      <option value="EMAIL_STATIC">EMAIL_STATIC</option>
                      <option value="PDF_STATIC">PDF_STATIC</option>
                      <option value="SVG">SVG</option>
                      <option value="PNG">PNG</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Content-Type</label>
                    <input name="contentType" defaultValue="image/svg+xml" className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Largeur</label>
                    <input name="width" type="number" min={1} defaultValue={512} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Hauteur</label>
                    <input name="height" type="number" min={1} defaultValue={256} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input name="isActive" type="checkbox" defaultChecked /> Actif
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Version</label>
                    <input name="version" type="number" min={1} defaultValue={1} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm mb-1">Contenu</label>
                    <textarea name="logoContent" required rows={8} className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs" placeholder="Collez ici le SVG, HTML ou base64 image" />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Annuler</Button>
                  <Button type="submit" disabled={createLoading}>{createLoading ? "Création..." : "Créer"}</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {!loading && error && (
          <div className="text-red-500 text-sm">{error}</div>
        )}

        {!loading && !error && (
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Libellé</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Taille</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logos.map((logo) => (
                  <TableRow key={logo.id}>
                    <TableCell className="font-mono text-xs">{logo.code}</TableCell>
                    <TableCell>{logo.label}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{logo.logoType}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-[color:var(--text-muted)]">{logo.width}×{logo.height}</span>
                    </TableCell>
                    <TableCell>
                      {logo.isActive ? (
                        <Badge className="bg-green-600 text-white">Actif</Badge>
                      ) : (
                        <Badge variant="outline">Inactif</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        <Dialog open={openId === logo.id} onOpenChange={(o) => setOpenId(o ? logo.id : null)}>
                          <DialogTrigger asChild>
                            <Button size="sm" variant="secondary" className="inline-flex items-center gap-2">
                              <Eye className="h-4 w-4" />
                              Voir
                            </Button>
                          </DialogTrigger>
                          <DialogContent
                            className="w-[92vw] max-w-[860px] p-0 overflow-hidden max-h-[88vh]"
                          >
                            <DialogHeader className="px-4 pt-4">
                              <DialogTitle className="text-base">{logo.label}</DialogTitle>
                              <DialogDescription className="text-xs">Prévisualisation du logo</DialogDescription>
                            </DialogHeader>
                            <Separator className="mt-2" />
                            <div className="p-4">
                              <PreviewBox logo={logo} />
                            </div>
                          </DialogContent>
                        </Dialog>

                        <Button size="sm" variant="secondary" className="inline-flex items-center gap-2" onClick={() => setEditLogo(logo)}>
                          <Pencil className="h-4 w-4" />
                          Éditer
                        </Button>

                        <Button size="sm" variant="destructive" className="inline-flex items-center gap-2" onClick={() => { setDeleteLogo(logo); setDeleteConfirm(""); }}>
                          <Trash className="h-4 w-4" />
                          Supprimer
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        )}

        {/* Edit Dialog */}
        {editLogo && (
          <Dialog open={!!editLogo} onOpenChange={(o) => !o && setEditLogo(null)}>
            <DialogContent className="w-[92vw] max-w-[820px] max-h-[88vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Éditer le logo</DialogTitle>
                <DialogDescription>Modifiez les champs ci-dessous.</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleUpdate} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm mb-1">Code</label>
                    <input value={editLogo.code} disabled className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Libellé</label>
                    <input name="label" defaultValue={editLogo.label} required className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm mb-1">Description</label>
                    <input name="description" defaultValue={editLogo.description || ""} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Type</label>
                    <select name="logoType" defaultValue={String(editLogo.logoType)} className="w-full rounded-md border bg-transparent px-3 py-2">
                      <option value="WEB_ANIMATED">WEB_ANIMATED</option>
                      <option value="EMAIL_STATIC">EMAIL_STATIC</option>
                      <option value="PDF_STATIC">PDF_STATIC</option>
                      <option value="SVG">SVG</option>
                      <option value="PNG">PNG</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Content-Type</label>
                    <input name="contentType" defaultValue={editLogo.contentType} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Largeur</label>
                    <input name="width" type="number" min={1} defaultValue={editLogo.width} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Hauteur</label>
                    <input name="height" type="number" min={1} defaultValue={editLogo.height} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input name="isActive" type="checkbox" defaultChecked={editLogo.isActive} /> Actif
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Version</label>
                    <input name="version" type="number" min={1} defaultValue={editLogo.version || 1} className="w-full rounded-md border bg-transparent px-3 py-2" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm mb-1">Contenu</label>
                    <textarea name="logoContent" defaultValue={editLogo.logoContent} rows={8} className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs" />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setEditLogo(null)}>Annuler</Button>
                  <Button type="submit" disabled={updateLoading}>{updateLoading ? "Enregistrement..." : "Enregistrer"}</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}

        {/* Delete Dialog */}
        {deleteLogo && (
          <Dialog open={!!deleteLogo} onOpenChange={(o) => !o && setDeleteLogo(null)}>
            <DialogContent className="w-[92vw] max-w-[520px]">
              <DialogHeader>
                <DialogTitle>Supprimer le logo</DialogTitle>
                <DialogDescription>
                  Cette action est irréversible. Tapez l'ID "{deleteLogo.id}" pour confirmer.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="text-sm"><span className="font-medium">{deleteLogo.label}</span> ({deleteLogo.code})</div>
                <input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={`Saisir ${deleteLogo.id}`}
                  className="w-full rounded-md border bg-transparent px-3 py-2"
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setDeleteLogo(null)}>Annuler</Button>
                  <Button type="button" variant="destructive" disabled={deleteLoading || deleteConfirm !== String(deleteLogo.id)} onClick={handleDelete}>
                    {deleteLoading ? "Suppression..." : "Supprimer"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
};