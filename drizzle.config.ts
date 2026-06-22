import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

// ENV=recette → .env.recette (recette/staging)
// défaut / ENV=production → .env (production)
const envFile = process.env.ENV === 'recette'
  ? '.env.recette'
  : '.env';
config({ path: envFile });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle-pg',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});