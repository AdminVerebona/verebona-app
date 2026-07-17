"use client"

import { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, X, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

interface ThumbnailUploadProps {
  currentThumbnail?: string | null;
  onThumbnailChange: (url: string | null) => void;
  assetId?: number;
}

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB for images

export function ThumbnailUpload({ currentThumbnail, onThumbnailChange, assetId }: ThumbnailUploadProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingSignedUrl, setIsLoadingSignedUrl] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [imageError, setImageError] = useState(false);

  // Fetch signed URL for existing thumbnail when assetId and currentThumbnail are provided
  useEffect(() => {
    const fetchSignedUrl = async () => {
      if (!currentThumbnail) {
        setPreview(null);
        setImageError(false);
        return;
      }

      // Blob URL = local preview after upload, use it directly
      if (currentThumbnail.startsWith('blob:')) {
        setPreview(currentThumbnail);
        setImageError(false);
        return;
      }

      // No assetId = creation mode: we already have a blob preview set during upload, keep it
      if (!assetId) {
        // Don't overwrite a valid blob preview with an inaccessible S3 URL
        setPreview(prev => (prev?.startsWith('blob:') ? prev : currentThumbnail));
        setImageError(false);
        return;
      }

      // Fetch signed URL from API
      setIsLoadingSignedUrl(true);
      try {
        const token = localStorage.getItem('bearer_token');
        if (!token) {
          setImageError(true);
          return;
        }

        const response = await fetch(`/api/assets/${assetId}/thumbnail`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setPreview(data.url);
          setImageError(false);
        } else {
          console.error('Failed to fetch signed URL:', response.status);
          setImageError(true);
        }
      } catch (error) {
        console.error('Error fetching signed URL:', error);
        setImageError(true);
      } finally {
        setIsLoadingSignedUrl(false);
      }
    };

    fetchSignedUrl();
  }, [currentThumbnail, assetId]);

  // Calculate SHA-256 hash
  const calculateHash = async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  // Upload image to S3 and get URL
  const uploadImage = async (file: File): Promise<string> => {
    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      throw new Error('Type de fichier non autorisé. Utilisez JPG, PNG, WebP ou GIF.');
    }

    // Validate file size
    if (file.size > MAX_IMAGE_SIZE) {
      throw new Error('Image trop volumineuse (max 5MB)');
    }

    if (file.size === 0) {
      throw new Error('Fichier vide');
    }

    const token = localStorage.getItem('bearer_token');
    if (!token) {
      throw new Error('SESSION_EXPIRED');
    }

    // Calculate hash
    setUploadProgress(10);
    const sha256Hash = await calculateHash(file);

    // Get presigned URL
    setUploadProgress(20);
    
    // Use a temporary assetId (0) if creating new asset
    const targetAssetId = assetId || 0;
    
    const presignResponse = await fetch('/api/files/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        assetId: targetAssetId,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        sha256Hash,
      }),
    });

    // Check for authentication errors
    if (presignResponse.status === 401 || presignResponse.status === 403) {
      throw new Error('SESSION_EXPIRED');
    }

    if (!presignResponse.ok) {
      const errorData = await presignResponse.json().catch(() => ({}));
      throw new Error(errorData.message || 'Erreur lors de la préparation de l\'upload');
    }

    const { uploadUrl, fileId: dbFileId, s3Key } = await presignResponse.json();
    setUploadProgress(40);

    // Upload to S3
    const xhr = new XMLHttpRequest();
    
    await new Promise<void>((resolve, reject) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percentComplete = 40 + (e.loaded / e.total) * 40;
          setUploadProgress(percentComplete);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          resolve();
        } else {
          reject(new Error('Erreur lors de l\'upload vers le stockage'));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Erreur réseau lors de l\'upload'));
      });

      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.send(file);
    });

    setUploadProgress(85);

    // Confirm upload
    const confirmResponse = await fetch('/api/files/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ fileId: dbFileId }),
    });

    if (!confirmResponse.ok) {
      const errorData = await confirmResponse.json().catch(() => ({}));
      throw new Error(errorData.message || 'Erreur lors de la confirmation');
    }

    setUploadProgress(100);

    // Construct public URL from S3 configuration
    const s3Endpoint = process.env.NEXT_PUBLIC_OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net';
    const s3Bucket = process.env.NEXT_PUBLIC_OVH_S3_BUCKET || 'owntrack';
    const publicUrl = `${s3Endpoint}/${s3Bucket}/${s3Key}`;

    return publicUrl;
  };

  // Handle file selection
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);
    setImageError(false);

    try {
      // Create preview
      const previewUrl = URL.createObjectURL(file);
      setPreview(previewUrl);

      // Upload file and get URL
      const uploadedUrl = await uploadImage(file);
      
      // Update parent with new URL
      onThumbnailChange(uploadedUrl);
      
      // Keep blob preview for now (it will be replaced on next load with signed URL)
      // setPreview(uploadedUrl); // Don't set the S3 URL directly
      
      toast.success('Photo uploadée avec succès !');
    } catch (error) {
      console.error('Error uploading thumbnail:', error);
      
      // Handle session expiration
      if (error instanceof Error && error.message === 'SESSION_EXPIRED') {
        toast.error('Votre session a expiré. Veuillez vous reconnecter.', {
          action: {
            label: 'Se reconnecter',
            onClick: () => {
              localStorage.removeItem('bearer_token');
              router.push('/login?redirect=' + encodeURIComponent(window.location.pathname));
            },
          },
          duration: 10000,
        });
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Erreur lors de l\'upload';
        toast.error(errorMessage);
      }
      
      // Reset preview on error
      setPreview(null);
      setImageError(true);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      // Reset input value to allow re-uploading the same file
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [onThumbnailChange, assetId, router]);

  // Remove thumbnail
  const handleRemove = () => {
    setPreview(null);
    setImageError(false);
    onThumbnailChange(null);
    toast.success('Photo supprimée');
  };

  const [dragOver, setDragOver] = useState(false);

  const triggerFileInput = () => fileInputRef.current?.click();
  const handleImageError = () => setImageError(true);
  const handleImageLoad = () => setImageError(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const fakeEvent = { target: { files: e.dataTransfer.files, value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>;
    handleFileSelect(fakeEvent);
  }, [handleFileSelect]);

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_IMAGE_TYPES.join(',')}
        onChange={handleFileSelect}
        className="hidden"
      />

      {isLoadingSignedUrl ? (
        <div className="h-32 rounded-xl bg-muted flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : preview && !imageError ? (
        <div className="relative rounded-xl overflow-hidden bg-muted" style={{ height: 160 }}>
          <img
            src={preview}
            alt="Aperçu"
            className="w-full h-full object-cover"
            onError={handleImageError}
            onLoad={handleImageLoad}
          />
          {isUploading && (
            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-7 h-7 animate-spin text-white" />
              <p className="text-sm font-medium text-white">{Math.round(uploadProgress)}%</p>
            </div>
          )}
          {!isUploading && (
            <div className="absolute top-2 right-2 flex gap-1.5">
              <Button type="button" variant="secondary" size="sm" onClick={triggerFileInput} className="shadow-lg h-7 px-2 text-xs">
                <Upload className="w-3 h-3 mr-1" />Changer
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={handleRemove} className="shadow-lg h-7 w-7 p-0">
                <X className="w-3 h-3" />
              </Button>
            </div>
          )}
        </div>
      ) : imageError ? (
        <div className="h-32 rounded-xl bg-muted border border-destructive/40 flex flex-col items-center justify-center gap-2">
          <AlertCircle className="w-5 h-5 text-destructive" />
          <p className="text-xs text-muted-foreground">Image non disponible</p>
          <Button type="button" variant="secondary" size="sm" onClick={triggerFileInput} className="h-7 px-2 text-xs">
            <Upload className="w-3 h-3 mr-1" />Changer
          </Button>
        </div>
      ) : (
        <div
          onClick={triggerFileInput}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={cn(
            'border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors',
            dragOver
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/40'
          )}
        >
          <Upload className="w-6 h-6 text-muted-foreground" />
          <div className="text-center">
            <p className="text-sm font-medium">
              {isUploading ? 'Chargement…' : 'Cliquer ou glisser une image'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">JPG, PNG, WEBP — max 5 Mo</p>
          </div>
        </div>
      )}
    </div>
  );
}