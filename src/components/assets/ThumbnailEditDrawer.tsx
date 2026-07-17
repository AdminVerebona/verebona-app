'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Upload, Check, ImageIcon, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface AssetFilePhoto {
  id: number;
  mimeType: string;
  originalFilename: string | null;
  s3Key: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  assetId: number;
  currentThumbnailUrl: string | null;
  onUpdated: (newThumbnailUrl: string, signedUrl: string) => void;
}

export function ThumbnailEditDrawer({ open, onClose, assetId, currentThumbnailUrl, onUpdated }: Props) {
  const [photos, setPhotos] = useState<AssetFilePhoto[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({});
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;

  // Fetch images belonging to this asset
  const loadPhotos = useCallback(async () => {
    if (!token) return;
    setLoadingPhotos(true);
    try {
      const res = await fetch(
        `/api/assets/${assetId}/photos`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return;
      const data = await res.json();
      const items: AssetFilePhoto[] = data.photos ?? [];
      setPhotos(items);

      // Fetch signed view URLs for each image
      const urlMap: Record<number, string> = {};
      await Promise.all(
        items.map(async (f) => {
          try {
            const vr = await fetch(`/api/files/${f.id}/view`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (vr.ok) {
              const vd = await vr.json();
              if (vd.viewUrl) urlMap[f.id] = vd.viewUrl;
            }
          } catch {/* ignore */}
        })
      );
      setPhotoUrls(urlMap);
    } catch {
      // silent
    } finally {
      setLoadingPhotos(false);
    }
  }, [assetId, token]);

  useEffect(() => {
    if (open) {
      setSelectedFileId(null);
      loadPhotos();
    }
  }, [open, loadPhotos]);

  // Upload a new image file directly as thumbnail
  const handleFileUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Seules les images sont acceptées');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image trop volumineuse (max 5 Mo)');
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);

      const res = await fetch(`/api/assets/${assetId}/thumbnail`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? 'Erreur lors de l\'upload');
      }

      const data = await res.json();
      toast.success('Vignette mise à jour');
      onUpdated(data.thumbnailUrl, data.signedUrl);
      onClose();
    } catch (e: any) {
      toast.error(e.message ?? 'Erreur lors de l\'upload');
    } finally {
      setUploading(false);
    }
  }, [assetId, token, onUpdated, onClose]);

  // Promote an existing assetFile as thumbnail
  const handleSaveSelection = useCallback(async () => {
    if (!selectedFileId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/assets/${assetId}/thumbnail`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fileId: selectedFileId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? 'Erreur lors de la mise à jour');
      }

      const data = await res.json();
      toast.success('Vignette mise à jour');
      onUpdated(data.thumbnailUrl, data.signedUrl);
      onClose();
    } catch (e: any) {
      toast.error(e.message ?? 'Erreur');
    } finally {
      setSaving(false);
    }
  }, [selectedFileId, assetId, token, onUpdated, onClose]);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle>Modifier la vignette</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Current thumbnail preview */}
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-2">Vignette actuelle</p>
            <div className="w-24 h-24 rounded-xl overflow-hidden bg-muted border flex items-center justify-center">
              {currentThumbnailUrl ? (
                <Image
                  src={currentThumbnailUrl}
                  alt="Vignette actuelle"
                  width={96}
                  height={96}
                  className="object-cover w-full h-full"
                />
              ) : (
                <ImageIcon className="w-8 h-8 text-muted-foreground/40" />
              )}
            </div>
          </div>

          {/* Upload zone */}
          <div>
            <p className="text-sm font-medium mb-2">Charger une nouvelle image</p>
            <div
              className={cn(
                'border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors',
                dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
              )}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files[0];
                if (file) handleFileUpload(file);
              }}
            >
              <Upload className="w-6 h-6 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium">
                  {uploading ? 'Chargement…' : 'Cliquer ou glisser une image'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">JPG, PNG, WEBP — max 5 Mo</p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
                e.target.value = '';
              }}
            />
          </div>

          {/* Existing photos grid */}
          <div>
            <p className="text-sm font-medium mb-2">Photos existantes du bien</p>
            {loadingPhotos ? (
              <div className="grid grid-cols-3 gap-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-lg" />
                ))}
              </div>
            ) : photos.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Aucune photo pour ce bien
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {photos.map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => setSelectedFileId(
                      selectedFileId === photo.id ? null : photo.id
                    )}
                    className={cn(
                      'relative aspect-square rounded-lg overflow-hidden border-2 transition-all',
                      selectedFileId === photo.id
                        ? 'border-primary ring-2 ring-primary/30'
                        : 'border-transparent hover:border-muted-foreground/30'
                    )}
                  >
                    {photoUrls[photo.id] ? (
                      <Image
                        src={photoUrls[photo.id]}
                        alt={photo.originalFilename ?? ''}
                        fill
                        className="object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-muted flex items-center justify-center">
                        <ImageIcon className="w-5 h-5 text-muted-foreground/40" />
                      </div>
                    )}
                    {selectedFileId === photo.id && (
                      <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                        <div className="bg-primary rounded-full p-1">
                          <Check className="w-3 h-3 text-primary-foreground" />
                        </div>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t">
          <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
            <button
              type="button"
              className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={onClose}
              disabled={saving || uploading}
            >
              <X className="w-4 h-4" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
            </button>
            <div className="w-px bg-border" />
            <button
              type="button"
              className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleSaveSelection}
              disabled={!selectedFileId || saving || uploading}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span className="text-[10px] font-semibold uppercase tracking-wider">{saving ? 'Sauvegarde…' : 'Utiliser'}</span>
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
