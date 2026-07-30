# Verification de l'integrite des fichiers livres.
#
# ═══════════════════════════════════════════════════════════════════════════
# CE SCRIPT DETECTE TROIS PROBLEMES, PAS UN SEUL
#
#   1. FICHIER ABSENT      — un lot appliqué partiellement ;
#   2. FICHIER DIVERGENT   — present, mais dans une version differente de
#                            celle livree. La version precedente du script ne
#                            le voyait pas : c'est ainsi que « Lire les CGSU »
#                            a survecu a un lot qui le remplacait ;
#   3. FICHIER PARASITE    — les doublons « (2) » que Windows cree lorsqu'on
#                            repond « Conserver les deux fichiers » a la boite
#                            de dialogue de copie. Ils ne compilent pas et
#                            masquent parfois la disparition de l'original.
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage, depuis la racine de verebona-app :
#     powershell -ExecutionPolicy Bypass -File .\verifier-fichiers.ps1
#
# Code de sortie 0 si tout concorde, 1 sinon.

$fichiers = @(
  @{ P = 'middleware.ts'; H = '5a76991ceaa8c044' },
  @{ P = 'scripts/corpus-dry.ts'; H = '00ecdabae71e2dbd' },
  @{ P = 'scripts/corpus-run.ts'; H = '25a0939befb688ed' },
  @{ P = 'scripts/corpus-status.ts'; H = '9fd1f7d9bbd79297' },
  @{ P = 'scripts/verify-legal-integrity.ts'; H = '391fb66a5a454e80' },
  @{ P = 'src/app/(auth)/login/page.tsx'; H = '5914124f8883069c' },
  @{ P = 'src/app/(auth)/signup/page.tsx'; H = '9553749a43463a50' },
  @{ P = 'src/app/(auth)/verify-email/page.tsx'; H = '307ab4e4b8f0ae13' },
  @{ P = 'src/app/abonnement/onboarding/page.tsx'; H = '4502ad3220f69c88' },
  @{ P = 'src/app/admin/cgvu/page.tsx'; H = '96d0343814f2951e' },
  @{ P = 'src/app/admin/retractations/page.tsx'; H = '741743b7703266e4' },
  @{ P = 'src/app/api/admin/document-categories/[id]/route.ts'; H = 'ce066c8cf14499af' },
  @{ P = 'src/app/api/admin/document-categories/route.ts'; H = '8af3771203ee8474' },
  @{ P = 'src/app/api/admin/legal/cgvu/drafts/[id]/publish/route.ts'; H = 'be31c064eda712d7' },
  @{ P = 'src/app/api/admin/legal/cgvu/drafts/[id]/route.ts'; H = '9a856050976b653d' },
  @{ P = 'src/app/api/admin/legal/cgvu/drafts/route.ts'; H = 'a93fe244bff0dbed' },
  @{ P = 'src/app/api/admin/legal/cgvu/versions/[id]/set-current/route.ts'; H = 'e6dabe9a21a670aa' },
  @{ P = 'src/app/api/admin/legal/cgvu/versions/route.ts'; H = 'ef2db0e6697da04e' },
  @{ P = 'src/app/api/admin/withdrawals/[reference]/actions/route.ts'; H = 'e64b0161cb6446d8' },
  @{ P = 'src/app/api/admin/withdrawals/[reference]/route.ts'; H = '7be351fff157eb49' },
  @{ P = 'src/app/api/admin/withdrawals/route.ts'; H = 'd743eeba964d9de1' },
  @{ P = 'src/app/api/auth/verify-email/route.ts'; H = 'cd1d909d6bafa5dc' },
  @{ P = 'src/app/api/cron/account-deletion/process/route.ts'; H = '168be0a80d4ab8af' },
  @{ P = 'src/app/api/cron/ai/purge-assistant-logs/route.ts'; H = '385b4fd0d91e38fd' },
  @{ P = 'src/app/api/cron/legal/verify-integrity/route.ts'; H = '0838ab465b2c5039' },
  @{ P = 'src/app/api/cron/withdrawal/process/route.ts'; H = 'fb0ae9b1b4b33da8' },
  @{ P = 'src/app/api/documents/[id]/classification/route.ts'; H = '70ea60e7163e0f41' },
  @{ P = 'src/app/api/documents/browse/route.ts'; H = '920cf6850756d644' },
  @{ P = 'src/app/api/health/route.ts'; H = '498947cbb4eb3421' },
  @{ P = 'src/app/api/legal/acceptances/route.ts'; H = 'a5b87c365c5b03f6' },
  @{ P = 'src/app/api/legal/cgvu/current/route.ts'; H = '9a2f2eb502531462' },
  @{ P = 'src/app/api/legal/cgvu/versions/[version]/download/route.ts'; H = 'bbf15261da7ba4de' },
  @{ P = 'src/app/api/legal/cgvu/versions/[version]/route.ts'; H = '07417ad17188944d' },
  @{ P = 'src/app/api/me/legal/acceptances/route.ts'; H = 'd41f1c8f48751674' },
  @{ P = 'src/app/api/me/legal/cgvu-applicable/route.ts'; H = 'f10d0907cdf29232' },
  @{ P = 'src/app/api/users/route.ts'; H = 'd0fd371419db29eb' },
  @{ P = 'src/app/api/withdrawal/[reference]/route.ts'; H = 'b5bd0a5343122aab' },
  @{ P = 'src/app/api/withdrawal/confirm/route.ts'; H = '53d332c7c7cf8059' },
  @{ P = 'src/app/api/withdrawal/eligibility/route.ts'; H = '3cddbadba4ca6deb' },
  @{ P = 'src/app/api/withdrawal/prepare/route.ts'; H = '266aec85ff8290ef' },
  @{ P = 'src/app/api/withdrawal/public/start/route.ts'; H = '6c64900f7fda2d09' },
  @{ P = 'src/app/api/withdrawal/public/verify/route.ts'; H = 'f5e9b607d0830049' },
  @{ P = 'src/app/cgvu/route.ts'; H = 'b2e56352e71c34f1' },
  @{ P = 'src/app/cgvu/versions/[version]/route.ts'; H = 'a73f5ca389a59d71' },
  @{ P = 'src/app/retractation/page.tsx'; H = '22163ae215176cc3' },
  @{ P = 'src/components/DashboardLayout.tsx'; H = 'd3546a7072d4956c' },
  @{ P = 'src/components/Footer.tsx'; H = '0e3033b0154f343f' },
  @{ P = 'src/components/LandingFooter.tsx'; H = '9743abc1e0ebd101' },
  @{ P = 'src/components/account/LegalInformationCard.tsx'; H = '7c564466cc91fd04' },
  @{ P = 'src/components/account/WithdrawalCard.tsx'; H = 'c15af221fd4e27bc' },
  @{ P = 'src/components/documents/CategoryAccordion.tsx'; H = 'd2edfd9ef550ec49' },
  @{ P = 'src/components/documents/DocumentCard.tsx'; H = '37448e891f85e095' },
  @{ P = 'src/components/documents/DocumentClassificationSection.tsx'; H = '342ca106349bee9e' },
  @{ P = 'src/components/documents/DocumentsView.tsx'; H = 'eb8eeee74648a551' },
  @{ P = 'src/components/documents/SortFilterDrawer.tsx'; H = '25bcf081b296732a' },
  @{ P = 'src/components/documents/__tests__/document-components.test.ts'; H = '0cc0d55e738e7529' },
  @{ P = 'src/components/documents/useDocumentBrowser.ts'; H = 'f4e97cbdb0629186' },
  @{ P = 'src/components/subscription/SubscriptionSummary.tsx'; H = '204690a24038da70' },
  @{ P = 'src/components/subscription/TrialBanner.tsx'; H = 'd23dd4930939085c' },
  @{ P = 'src/components/upload-notice-banner.tsx'; H = 'd20f5d6b303e3efd' },
  @{ P = 'src/db/index.ts'; H = 'aa91922a5af558cc' },
  @{ P = 'src/db/migrations/0112_users_schema_alignment.sql'; H = '15d654cdbe993f45' },
  @{ P = 'src/db/migrations/0113_signup_context_account_link.sql'; H = '2d1b0d0d30eba5fa' },
  @{ P = 'src/db/migrations/0114_pricing_public_catalog_source.sql'; H = 'a3610a0123994d9c' },
  @{ P = 'src/db/migrations/0115_legal_document_versions.sql'; H = '22e297ded433618b' },
  @{ P = 'src/db/migrations/0116_scheduled_account_deletions.sql'; H = '2583f5dec5c96822' },
  @{ P = 'src/db/migrations/0117_withdrawal_requests.sql'; H = '670a15c3f4e12d51' },
  @{ P = 'src/db/migrations/0118_withdrawal_events.sql'; H = 'e810ce6bda567d92' },
  @{ P = 'src/db/migrations/0119_document_categories.sql'; H = '2a8559422cc20278' },
  @{ P = 'src/db/seeds/corpus/seed-corpus-account.ts'; H = '9eba9adc95b02fc7' },
  @{ P = 'src/db/seeds/documents/category-referential.ts'; H = '86931a876d81305c' },
  @{ P = 'src/db/seeds/documents/seed-document-categories.ts'; H = 'b05552858bbeaeba' },
  @{ P = 'src/db/seeds/legal/cgvu-v1.content.ts'; H = '482b01e58cb4ee78' },
  @{ P = 'src/db/seeds/legal/email_template_cgvu.ts'; H = 'cdb35379429af3d5' },
  @{ P = 'src/db/seeds/legal/seed-cgvu.ts'; H = '2042a8e350bdc89f' },
  @{ P = 'src/db/seeds/withdrawal/email_template_withdrawal.ts'; H = '47d1038bd0209b3f' },
  @{ P = 'src/lib/__tests__/no-bearer-token.test.ts'; H = '36e4b874a67c3748' },
  @{ P = 'src/lib/load-env.ts'; H = '43df6743cb2150b2' },
  @{ P = 'src/scripts/migrate-auth-storage.ts'; H = '5b9c83de4279af0a' },
  @{ P = 'src/services/__tests__/referral-attribution.test.ts'; H = '82088be9303d05e0' },
  @{ P = 'src/services/account/__tests__/scheduled-deletion.test.ts'; H = '29679ad64363d962' },
  @{ P = 'src/services/account/scheduled-deletion.service.ts'; H = 'bb8f1f93fbb39360' },
  @{ P = 'src/services/ai/gateway/pricing/__tests__/gemini-public-catalog.test.ts'; H = '14eec9258fd241ca' },
  @{ P = 'src/services/ai/gateway/pricing/gemini-public-catalog.ts'; H = '7b91f3b7dd7367dc' },
  @{ P = 'src/services/ai/gateway/pricing/gemini-public.source.ts'; H = '81dde7a13e171b64' },
  @{ P = 'src/services/ai/governance/corpus/__tests__/corpus-cases.test.ts'; H = 'a68e2345df68cede' },
  @{ P = 'src/services/ai/governance/corpus/__tests__/corpus-comparator.test.ts'; H = '3c4333c1845b1501' },
  @{ P = 'src/services/ai/governance/corpus/analysis-runner.ts'; H = 'b3c3b58a938b472a' },
  @{ P = 'src/services/ai/governance/corpus/corpus-cases.ts'; H = '9a3bbef52282fb48' },
  @{ P = 'src/services/ai/governance/corpus/corpus-comparator.ts'; H = 'e71c5d2285dc6b0c' },
  @{ P = 'src/services/ai/governance/corpus/corpus-runner.ts'; H = '9a15977ad78b3fb1' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/acte_immobilier/acte-vente-appartement.html'; H = 'c19d2a92ca5f14c2' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/acte_immobilier/acte-vente-maison.html'; H = 'c32ba67c117e774c' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/acte_immobilier/compromis-vente-terrain.html'; H = '818f16a0c00b0ea9' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/avis_echeance/avis-echeance-auto.html'; H = '8b9a4dfbeb501568' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/avis_echeance/avis-echeance-habitation.html'; H = 'fe2b731497cac1f5' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/carte_grise/certificat-immatriculation-moto.html'; H = '3d2c26f5d2d02bc8' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/carte_grise/certificat-immatriculation-voiture.html'; H = '77ff8fc24bdb2bac' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/contrat_loa_lld/contrat-lld-utilitaire.html'; H = 'a27850e033bf15f4' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/contrat_loa_lld/contrat-loa-voiture.html'; H = '1ee831a0847909fa' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/document_contradictoire/annonce-immobiliere-surface.html'; H = '812899e6089af871' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/document_contradictoire/avis-echeance-prime-differente.html'; H = 'cc37c13c452cf68e' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/document_sans_information/page-separation-vierge.html'; H = '3853282a78b36a8e' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/document_sans_information/ticket-illisible.html'; H = '462f6e5c372ee660' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/dpe/dpe-appartement-bordeaux.html'; H = 'f14613609dcaa9a3' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/dpe/dpe-maison-fleury.html'; H = '4a6dfb16764d8519' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/facture_equipement/facture-ordinateur-pro.html'; H = 'f31578a3aa0f975f' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/facture_equipement/facture-pompe-chaleur.html'; H = '80afd88b870b0186' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/facture_multibiens/facture-assurance-deux-biens.html'; H = 'a4c71a7b470887b9' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/facture_multibiens/facture-travaux-deux-lots.html'; H = '59b69c243662a65e' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/garantie/certificat-garantie-electromenager.html'; H = '7dc8de98ef81522c' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/garantie/extension-garantie-pompe-chaleur.html'; H = '570a24938bbddf80' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/multi_fichiers_meme_document/dpe-bordeaux-page1.html'; H = '36679b6b15f4cf1d' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/multi_fichiers_meme_document/dpe-bordeaux-page2.html'; H = '4fdf5c578ca74c3e' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/multi_fichiers_meme_document/dpe-bordeaux-page3.html'; H = 'f227ba9d6d1700bf' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/page_web/annonce-portail-immobilier.html'; H = '4bd6d6193d58ca00' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/page_web/fiche-produit-fabricant.html'; H = 'ab0198c25f8ce396' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/rapport_entretien/rapport-entretien-chaudiere.html'; H = 'cd337a7a1de8853b' },
  @{ P = 'src/services/ai/governance/corpus/fixtures/rapport_entretien/rapport-revision-voiture.html'; H = '95e5273510d2ba7b' },
  @{ P = 'src/services/ai/source-analysis/__tests__/web-link-entrypoint.test.ts'; H = '5565a36411b80467' },
  @{ P = 'src/services/documents/__tests__/classification-rules.test.ts'; H = 'b4344ddd83acb972' },
  @{ P = 'src/services/documents/__tests__/document-query.test.ts'; H = 'b5091d8a5cf77bb5' },
  @{ P = 'src/services/documents/classification-rules.ts'; H = 'c2d0a9102af9e3a7' },
  @{ P = 'src/services/documents/classification.service.ts'; H = '74dd410d21b539f3' },
  @{ P = 'src/services/documents/document-query.contract.ts'; H = 'a7a02ffd7007fb48' },
  @{ P = 'src/services/documents/document-query.service.ts'; H = '7e73452542da324f' },
  @{ P = 'src/services/legal/__tests__/french-calendar.test.ts'; H = '46aa058cf51acd10' },
  @{ P = 'src/services/legal/__tests__/legal-acceptances.test.ts'; H = '33ed4d005aba52c7' },
  @{ P = 'src/services/legal/__tests__/legal-confirmation.test.ts'; H = 'f04469c0c2442c4f' },
  @{ P = 'src/services/legal/__tests__/legal-html.test.ts'; H = '771342106f8c0254' },
  @{ P = 'src/services/legal/__tests__/legal-seed-content.test.ts'; H = '418f050135d82a56' },
  @{ P = 'src/services/legal/french-calendar.ts'; H = '70972a32c76921bc' },
  @{ P = 'src/services/legal/index.ts'; H = 'eb81ed8ad8f29535' },
  @{ P = 'src/services/legal/legal-acceptances.service.ts'; H = '0f533f8ca51335f1' },
  @{ P = 'src/services/legal/legal-audit.service.ts'; H = 'a28c9910f0a9aeb2' },
  @{ P = 'src/services/legal/legal-confirmation.service.ts'; H = '08da9907a580634e' },
  @{ P = 'src/services/legal/legal-error-page.ts'; H = '44b6acb45e393356' },
  @{ P = 'src/services/legal/legal-html.renderer.ts'; H = '1a6f2a92c72fec40' },
  @{ P = 'src/services/legal/legal-storage.ts'; H = 'ada0c24179037f87' },
  @{ P = 'src/services/legal/legal-subscription.hook.ts'; H = '8449f94e1a8c21d6' },
  @{ P = 'src/services/legal/legal-versions.service.ts'; H = '05a99d38614f9c00' },
  @{ P = 'src/services/referral-attribution.service.ts'; H = '7d1c23df7eb3f638' },
  @{ P = 'src/services/withdrawal/__tests__/refund-calculator.test.ts'; H = '54f71af4ce3c65f2' },
  @{ P = 'src/services/withdrawal/__tests__/withdrawal-journal.test.ts'; H = 'e0abef67a26d1c83' },
  @{ P = 'src/services/withdrawal/__tests__/withdrawal-ui.test.ts'; H = '622d36795e9c6d6f' },
  @{ P = 'src/services/withdrawal/__tests__/withdrawal.test.ts'; H = '1a0dcf4a1c76e417' },
  @{ P = 'src/services/withdrawal/eligibility.service.ts'; H = 'f95a822cce1df7c0' },
  @{ P = 'src/services/withdrawal/public-verification.service.ts'; H = '03e7497897d09147' },
  @{ P = 'src/services/withdrawal/receipt.service.ts'; H = 'c2bde93d5447a1e3' },
  @{ P = 'src/services/withdrawal/refund-calculator.ts'; H = '49ced436f66f5fa0' },
  @{ P = 'src/services/withdrawal/summary.service.ts'; H = '9bfcb262c04f6cd4' },
  @{ P = 'src/services/withdrawal/withdrawal-journal.service.ts'; H = 'b3c5df9f3284bc3e' },
  @{ P = 'src/services/withdrawal/withdrawal-processor.service.ts'; H = '31140600236344ca' },
  @{ P = 'src/services/withdrawal/withdrawal-webhook.service.ts'; H = '02f8b0669a1c38c1' },
  @{ P = 'src/services/withdrawal/withdrawal.service.ts'; H = '2abcd7d945e22246' }
)

$absents    = @()
$divergents = @()

foreach ($f in $fichiers) {
  if (-not (Test-Path -LiteralPath $f.P)) {
    $absents += $f.P
    continue
  }
  # Empreinte tronquee a 16 caracteres : suffisant pour distinguer deux
  # versions d'un meme fichier, assez court pour rester lisible.
  $h = (Get-FileHash -LiteralPath $f.P -Algorithm SHA256).Hash.ToLower().Substring(0, 16)
  if ($h -ne $f.H) { $divergents += $f.P }
}

# Doublons de copie Windows : « fichier (2).tsx », « fichier - Copie.ts »...
$parasites = Get-ChildItem -Path .\src -Recurse -File -Include *.ts, *.tsx -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '\((\d+)\)' -or $_.Name -match '- Copie' -or $_.Name -match '- Copy' } |
  ForEach-Object { Resolve-Path -Relative $_.FullName }

Write-Host ""
Write-Host "$($fichiers.Count) fichier(s) attendu(s)."

if ($absents.Count -gt 0) {
  Write-Host ""
  Write-Host "$($absents.Count) ABSENT(S) :" -ForegroundColor Red
  $absents | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
}

if ($divergents.Count -gt 0) {
  Write-Host ""
  Write-Host "$($divergents.Count) DIVERGENT(S) - present mais pas dans la version livree :" -ForegroundColor Yellow
  $divergents | ForEach-Object { Write-Host "   $_" -ForegroundColor Yellow }
}

if ($parasites.Count -gt 0) {
  Write-Host ""
  Write-Host "$($parasites.Count) PARASITE(S) - doublon(s) de copie Windows, a supprimer :" -ForegroundColor Magenta
  $parasites | ForEach-Object { Write-Host "   $_" -ForegroundColor Magenta }
  Write-Host ""
  Write-Host "   Ils proviennent de la reponse « Conserver les deux fichiers »" -ForegroundColor Magenta
  Write-Host "   a la boite de dialogue de copie. Voir le LISEZ-MOI pour la" -ForegroundColor Magenta
  Write-Host "   methode de copie qui evite cette question." -ForegroundColor Magenta
}

if ($absents.Count -eq 0 -and $divergents.Count -eq 0 -and $parasites.Count -eq 0) {
  Write-Host "OK - tous les fichiers sont presents et conformes." -ForegroundColor Green
  exit 0
}
exit 1
