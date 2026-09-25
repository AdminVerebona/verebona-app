"use client"

/**
 * Modèles e-mail — consultation, aperçu et test (CDC Back-Office V1 §10).
 *
 * COM-013 / REC-MOD-06 : le contenu n'est pas éditable depuis le BO. L'éditeur
 * (sujet / corps), la réinitialisation et l'initialisation (« seed ») ont été
 * retirés avec leurs routes API ; le contenu est versionné dans le code ou les
 * migrations. L'aperçu reste disponible en lecture seule.
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Mail, Send, Settings, Code, Eye } from 'lucide-react';

interface EmailTemplate {
  id: number;
  type: string;
  subject: string;
  body: string;
  placeholders: string | null;
  updatedAt: string;
}

interface EmailSettings {
  id: number;
  emailsEnabled: boolean;
  senderName: string;
  senderEmail: string;
  replyToEmail: string;
  primaryColor: string;
  footerText: string | null;
  logoUrl: string | null;
  logoUrlLight: string | null;
  logoUrlDark: string | null;
}

export default function AdminEmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Aperçu (lecture seule)
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  
  // Test dialog state
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testTemplate, setTestTemplate] = useState<EmailTemplate | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  
  // Settings form state
  const [settingsFormData, setSettingsFormData] = useState<Partial<EmailSettings>>({});

  const [previewMode, setPreviewMode] = useState<'code' | 'preview'>('code');


  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    await Promise.all([loadTemplates(), loadSettings()]);
  };

  const loadTemplates = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const response = await fetch('/api/admin/email-templates', {
      credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement des templates');
      }

      const data = await response.json();
      
        // Filtrer pour ne garder que les templates système MVP + multi-user
        const systemTemplates = data.filter((t: EmailTemplate) =>
          ['EMAIL_VERIFICATION', 'WELCOME', 'PASSWORD_RESET', 'DEADLINE_REMINDER', 'DEADLINE_OVERDUE', 'PREMIUM_CONFIRMATION', 'DUO_INVITATION', 'MEMBER_REMOVED_DUE_TO_DOWNGRADE', 'ACCOUNT_MEMBER_REMOVED', 'ACCOUNT_INVITATION'].includes(t.type)
        );
      
      setTemplates(systemTemplates);
    } catch (err) {
      console.error('Error loading templates:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const response = await fetch('/api/admin/email-settings', {
      credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setSettings(data);
        setSettingsFormData(data);
      }
    } catch (err) {
      console.error('Error loading settings:', err);
    }
  };

  const handleSaveSettings = async () => {
    try {
      setSettingsLoading(true);

      const response = await fetch('/api/admin/email-settings', {
      credentials: 'include',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settingsFormData),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la mise à jour des paramètres');
      }

      const updated = await response.json();
      setSettings(updated);
      setSettingsFormData(updated);
      toast.success('Paramètres mis à jour avec succès');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSettingsLoading(false);
    }
  };

  const handlePreview = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setPreviewMode('preview');
    setEditDialogOpen(true);
  };

  const handleTestOpen = (template: EmailTemplate) => {
    setTestTemplate(template);
    // Pré-remplir avec l'email de l'admin connecté
    try {
      const userData = JSON.parse(localStorage.getItem('user') || '{}');
      setTestEmail(userData.email || '');
    } catch {
      setTestEmail('');
    }
    setTestDialogOpen(true);
  };

  const handleTestSend = async () => {
    if (!testTemplate) return;

    try {
      setTestLoading(true);

      const response = await fetch(`/api/admin/email-templates/${testTemplate.id}/test`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // COM-010 : le serveur envoie à l'adresse de l'administrateur connecté.
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de l\'envoi du test');
      }

      toast.success('Email de test envoyé avec succès');
      setTestDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de l\'envoi');
    } finally {
      setTestLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      'EMAIL_VERIFICATION': 'Vérification email',
      'WELCOME': 'Bienvenue',
      'PASSWORD_RESET': 'Réinitialisation mot de passe',
      'DEADLINE_REMINDER': 'Rappel échéance',
      'DEADLINE_OVERDUE': 'Échéance dépassée',
      'PREMIUM_CONFIRMATION': 'Confirmation abonnement Premium',
      'DUO_INVITATION': 'Invitation DUO',
      'MEMBER_REMOVED_DUE_TO_DOWNGRADE': 'Membre retiré (downgrade)',
      'ACCOUNT_MEMBER_REMOVED': 'Membre retiré du compte',
      'ACCOUNT_INVITATION': 'Invitation compte',
    };
    return labels[type] || type;
  };

  const parsePlaceholders = (placeholders: string | null): string[] => {
    if (!placeholders) return [];
    try {
      return JSON.parse(placeholders);
    } catch {
      return [];
    }
  };

  const isHtmlContent = (content: string): boolean => {
    return /<[a-z][\s\S]*>/i.test(content);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Templates Email</h1>
          <p className="text-muted-foreground mt-1">
            Consultation des e-mails transactionnels système
          </p>
        </div>
      </div>

      {/* Paramètres Généraux */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Paramètres Généraux des Emails
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {settings ? (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <Label>Activer l'envoi d'emails</Label>
                  <p className="text-sm text-muted-foreground">
                    Désactive tous les envois en cas d'incident
                  </p>
                </div>
                <Switch
                  checked={settingsFormData.emailsEnabled ?? true}
                  onCheckedChange={(checked) => 
                    setSettingsFormData({ ...settingsFormData, emailsEnabled: checked })
                  }
                />
              </div>

              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                <div>
                  <Label htmlFor="senderName">Nom expéditeur</Label>
                  <Input
                    id="senderName"
                    value={settingsFormData.senderName || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, senderName: e.target.value })
                    }
                    placeholder="Verebona"
                  />
                </div>

                <div>
                  <Label htmlFor="senderEmail">Email expéditeur</Label>
                  <Input
                    id="senderEmail"
                    type="email"
                    value={settingsFormData.senderEmail || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, senderEmail: e.target.value })
                    }
                    placeholder="noreply@verebona.com"
                  />
                </div>
              </div>

                <div>
                  <Label htmlFor="replyToEmail">Email de réponse</Label>
                  <Input
                    id="replyToEmail"
                    type="email"
                    value={settingsFormData.replyToEmail || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, replyToEmail: e.target.value })
                    }
                    placeholder="support@verebona.com"
                  />
                </div>

                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="logoUrl">URL du logo (Public)</Label>
                    <Input
                      id="logoUrl"
                      value={settingsFormData.logoUrl || ''}
                      onChange={(e) => 
                        setSettingsFormData({ ...settingsFormData, logoUrl: e.target.value })
                      }
                      placeholder="https://example.com/logo.png"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Utilisé si les versions claire/sombre ne sont pas définies.
                    </p>
                  </div>

                  <div>
                    <Label htmlFor="logoUrlLight">URL du logo (Version Claire)</Label>
                    <Input
                      id="logoUrlLight"
                      value={settingsFormData.logoUrlLight || ''}
                      onChange={(e) => 
                        setSettingsFormData({ ...settingsFormData, logoUrlLight: e.target.value })
                      }
                      placeholder="https://example.com/logo-light.png"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="logoUrlDark">URL du logo (Version Sombre)</Label>
                  <Input
                    id="logoUrlDark"
                    value={settingsFormData.logoUrlDark || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, logoUrlDark: e.target.value })
                    }
                    placeholder="https://example.com/logo-dark.png"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Optionnel. Si vide, la version claire ou par défaut sera utilisée.
                  </p>
                </div>

                <div>
                  <Label htmlFor="footerText">Texte du footer</Label>
                <Textarea
                  id="footerText"
                  value={settingsFormData.footerText || ''}
                  onChange={(e) => 
                    setSettingsFormData({ ...settingsFormData, footerText: e.target.value })
                  }
                  placeholder="© 2025 Verebona. Tous droits réservés."
                  rows={2}
                />
              </div>

              <Button 
                onClick={handleSaveSettings} 
                disabled={settingsLoading}
              >
                {settingsLoading ? 'Enregistrement...' : 'Sauvegarder les paramètres'}
              </Button>
            </>
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>

      {/* Templates List */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Templates Système</h2>
        {isLoading ? (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <div className="text-center text-muted-foreground">
                <p className="mb-4">Aucun template système trouvé.</p>
                <p className="text-sm">
                  Exécutez le seeder pour créer les templates par défaut :
                </p>
                <code className="block mt-2 p-2 bg-muted rounded text-xs">
                  bun src/db/seeds/email_templates_system.ts
                </code>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => (
              <Card key={template.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Mail className="w-4 h-4" />
                    {getTypeLabel(template.type)}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Sujet</div>
                    <div className="text-sm font-medium">{template.subject}</div>
                  </div>

                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Corps</div>
                    <div className="text-sm line-clamp-3 bg-muted p-2 rounded">
                      {template.body}
                    </div>
                  </div>

                  {template.placeholders && (
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Variables disponibles</div>
                      <div className="flex flex-wrap gap-1">
                        {parsePlaceholders(template.placeholders).map((placeholder) => (
                          <Badge key={placeholder} variant="secondary" className="text-xs font-mono">
                            {`{{${placeholder}}}`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="text-xs text-muted-foreground pt-2 border-t">
                    Mis à jour le {formatDate(template.updatedAt)}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handlePreview(template)}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      Aperçu
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTestOpen(template)}
                      title="Envoyer un email de test"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Aperçu (lecture seule, COM-013) */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Aperçu du modèle e-mail</DialogTitle>
            <DialogDescription>
              {editingTemplate && `Modèle : ${getTypeLabel(editingTemplate.type)} — contenu non modifiable depuis le back-office.`}
            </DialogDescription>
          </DialogHeader>

          {editingTemplate && (
            <div className="space-y-4 overflow-y-auto flex-1">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Sujet</div>
                <div className="text-sm font-medium">{editingTemplate.subject}</div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm text-muted-foreground">Corps du message</div>
                  <Tabs value={previewMode} onValueChange={(v) => setPreviewMode(v as 'code' | 'preview')} className="w-auto">
                    <TabsList className="h-8">
                      <TabsTrigger value="preview" className="text-xs h-7 px-3">
                        <Eye className="h-3 w-3 mr-1" />
                        Aperçu
                      </TabsTrigger>
                      <TabsTrigger value="code" className="text-xs h-7 px-3">
                        <Code className="h-3 w-3 mr-1" />
                        Source
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                <div className="border rounded-md p-4 bg-muted min-h-[400px] max-h-[400px] overflow-auto">
                  {previewMode === 'preview' && isHtmlContent(editingTemplate.body) ? (
                    <div
                      dangerouslySetInnerHTML={{ __html: editingTemplate.body }}
                      className="prose prose-sm max-w-none"
                    />
                  ) : (
                    <pre className={`whitespace-pre-wrap text-sm ${previewMode === 'code' ? 'font-mono' : 'font-sans'}`}>
                      {editingTemplate.body}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Fermer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test Dialog */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tester l'envoi d'email</DialogTitle>
            <DialogDescription>
              {testTemplate && `Template: ${getTypeLabel(testTemplate.type)}`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              L&apos;e-mail de test est envoyé à votre adresse d&apos;administrateur, avec des valeurs de test automatiques.
            </p>

            {testTemplate && (
              <div className="bg-muted p-3 rounded text-sm">
                <div className="font-medium mb-1">Aperçu:</div>
                <div className="space-y-1 text-muted-foreground">
                  <div><strong>Sujet:</strong> {testTemplate.subject}</div>
                  <div><strong>Corps:</strong> {testTemplate.body.substring(0, 100)}...</div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTestDialogOpen(false)}
              disabled={testLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleTestSend}
              disabled={testLoading}
            >
              <Send className="h-4 w-4 mr-2" />
              {testLoading ? 'Envoi...' : 'Envoyer le test'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
