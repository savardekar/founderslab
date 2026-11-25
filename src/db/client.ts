import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzleLite } from 'drizzle-orm/pglite';
import { migrate as migrateLite } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { ALL_PERMISSION_KEYS, RESOURCES, type Resource } from '@/lib/constants';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

const migrationsFolder = path.join(process.cwd(), 'drizzle');
const g = globalThis as unknown as { __db?: Promise<Db> };

/** Opens the database, applies migrations, seeds the permission catalog. Memoised per process. */
export function getDb(): Promise<Db> {
  return (g.__db ??= openDb());
}

/** Fresh isolated in-memory Postgres (PGlite) for tests. */
export async function createTestDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = drizzleLite(new PGlite(), { schema });
  await migrateLite(db, { migrationsFolder });
  await seedPermissions(db as unknown as Db);
  return db as unknown as Db;
}

async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  let db: Db;
  if (url) {
    const { Pool } = await import('pg');
    const d = drizzlePg(new Pool({ connectionString: url, max: 10 }), { schema });
    await migratePg(d, { migrationsFolder });
    db = d as unknown as Db;
  } else {
    const { PGlite } = await import('@electric-sql/pglite');

    const dir = path.resolve(
      process.env.PGLITE_DIR ?? './.data/pglite'
    );

    // Ensure parent directory exists before opening PGlite
    await mkdir(path.dirname(dir), { recursive: true });

    const d = drizzleLite(new PGlite(dir), { schema });
    
    await migrateLite(d, { migrationsFolder });
    db = d as unknown as Db;
  }
  await seedPermissions(db);
  return db;
}

export async function seedPermissions(db: Db) {
  const rows = ALL_PERMISSION_KEYS.map((key) => {
    const [resource, action] = key.split('.') as [Resource, string];
    return { key, resource, action, description: `${action} — ${RESOURCES[resource]}` };
  });
  await db.insert(schema.permissions).values(rows).onConflictDoNothing();
}
