import { expect, test } from '@playwright/test';
import pg from 'pg';

/**
 * Hosted Postgres (Supabase) exposes the `public` schema over an HTTP API to
 * anyone holding the publishable key. Every SEKAI table must therefore have
 * row-level security on, so that API sees nothing. Fails if a future migration
 * adds a table without it.
 */
test('every public table has row-level security enabled', async () => {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://ytroom:ytroom@localhost:5432/ytroom',
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity",
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);
  } finally {
    await client.end();
  }
});
