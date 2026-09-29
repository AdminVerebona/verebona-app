/**
 * Fabriques de données relationnelles — harnais E2E (CDC 15 T2-41).
 *
 * Écriture SQL directe, volontairement : une fabrique qui passerait par les
 * services testés masquerait leurs défauts. Chaque fabrique ne remplit que
 * les colonnes obligatoires et ce que le scénario demande ; tout le reste
 * garde les défauts de la base — c'est-à-dire l'état d'une donnée réelle.
 *
 * Isolation : chaque appel porte un suffixe unique (`uid()`), les scénarios
 * peuvent donc partager la base de l'exécution sans se voir.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql;

let compteur = 0;
/** Suffixe unique à l'exécution. */
export function uid(prefix = 'e2e'): string {
  compteur += 1;
  return `${prefix}${Date.now().toString(36)}${compteur}`;
}

export interface UserRow { id: number; email: string }
export interface AccountRow { id: number; ownerUserId: number }
export interface AssetRow { id: number; accountId: number; userId: number }
export interface DocumentRow { id: number; assetId: number }
export interface AssetFileRow { id: number; accountId: number; assetId: number | null }
export interface AgendaItemRow { id: number; accountId: number }

export function factories(sql: Sql) {
  return {
    async user(over: { email?: string; planType?: string; role?: string } = {}): Promise<UserRow> {
      const email = over.email ?? `${uid('u')}@test.invalid`;
      const [u] = await sql<{ id: number }[]>`
        INSERT INTO users (email, password_hash, status)
        VALUES (${email}, 'e2e-non-connectable', 'ACTIVE') RETURNING id`;
      if (over.planType) await sql`UPDATE users SET plan_type = ${over.planType} WHERE id = ${u.id}`;
      if (over.role) await sql`UPDATE users SET role = ${over.role} WHERE id = ${u.id}`;
      return { id: u.id, email };
    },

    /** Compte avec son titulaire (créé si absent) et l'adhésion `owner`. */
    async account(over: { owner?: UserRow; name?: string } = {}): Promise<AccountRow & { owner: UserRow }> {
      const owner = over.owner ?? await this.user();
      const [a] = await sql<{ id: number }[]>`
        INSERT INTO accounts (name, owner_user_id) VALUES (${over.name ?? uid('compte')}, ${owner.id}) RETURNING id`;
      await sql`INSERT INTO account_memberships (account_id, user_id, role, status)
                VALUES (${a.id}, ${owner.id}, 'owner', 'active')`;
      return { id: a.id, ownerUserId: owner.id, owner };
    },

    async asset(account: AccountRow, over: {
      category?: string; name?: string; registrationNumber?: string | null;
      keyCharacteristics?: Record<string, unknown>; purchaseDate?: string | null; purchasePriceCents?: number | null;
    } = {}): Promise<AssetRow> {
      const [a] = await sql<{ id: number }[]>`
        INSERT INTO assets (user_id, account_id, category, name, registration_number, key_characteristics,
                            purchase_date, purchase_price_cents)
        VALUES (${account.ownerUserId}, ${account.id}, ${over.category ?? 'VEHICULE'}, ${over.name ?? uid('bien')},
                ${over.registrationNumber ?? null},
                ${over.keyCharacteristics ? JSON.stringify(over.keyCharacteristics) : null},
                ${over.purchaseDate ?? null}, ${over.purchasePriceCents ?? null})
        RETURNING id`;
      return { id: a.id, accountId: account.id, userId: account.ownerUserId };
    },

    /** Fichier déposé (source T1), rattaché ou non à un bien. */
    async assetFile(account: AccountRow, over: { assetId?: number | null; name?: string; mimeType?: string } = {}): Promise<AssetFileRow> {
      const name = over.name ?? `${uid('f')}.pdf`;
      const [f] = await sql<{ id: number }[]>`
        INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type)
        VALUES (${account.ownerUserId}, ${account.id}, ${over.assetId ?? null}, ${`e2e/${account.id}/${name}`},
                ${over.mimeType ?? 'application/pdf'})
        RETURNING id`;
      return { id: f.id, accountId: account.id, assetId: over.assetId ?? null };
    },

    async document(asset: AssetRow, over: { documentType?: string; fileName?: string; mimeType?: string } = {}): Promise<DocumentRow> {
      const [d] = await sql<{ id: number }[]>`
        INSERT INTO documents (user_id, asset_id, file_url, file_name, mime_type, document_type)
        VALUES (${asset.userId}, ${asset.id}, ${`e2e://${uid('doc')}`}, ${over.fileName ?? `${uid('doc')}.pdf`},
                ${over.mimeType ?? 'application/pdf'}, ${over.documentType ?? 'FACTURE'})
        RETURNING id`;
      return { id: d.id, assetId: asset.id };
    },

    /** Élément d'agenda, lié à un ou plusieurs biens. */
    async agendaItem(account: AccountRow, over: { title?: string; startDate?: string; assetIds?: number[] } = {}): Promise<AgendaItemRow> {
      const [i] = await sql<{ id: number }[]>`
        INSERT INTO agenda_items (account_id, title, start_date)
        VALUES (${account.id}, ${over.title ?? uid('evt')}, ${over.startDate ?? null})
        RETURNING id`;
      for (const assetId of over.assetIds ?? []) {
        await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${i.id}, ${assetId})`;
      }
      return { id: i.id, accountId: account.id };
    },
  };
}

export type Factories = ReturnType<typeof factories>;
