-- SEKAI: lock the public schema against hosted-Postgres data APIs.
--
-- Supabase (and similar hosts) expose the `public` schema over an HTTP API to
-- anyone holding the project's publishable/anon key, which is public by
-- design. SEKAI never uses that API: only the Rust server reads and writes the
-- database, connecting as the tables' owner. So:
--
--   1. Enable row-level security on every table, with no policies. Non-owner
--      roles see and change nothing. The owner (the SEKAI server) is exempt
--      because RLS is not FORCEd.
--   2. Where the API roles exist, revoke their privileges outright, now and
--      for objects created later.
--
-- On a plain Postgres (local Docker, CI) step 2 is a no-op and step 1 changes
-- nothing for the owning role.

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END
$$;

DO $$
DECLARE
    api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
        END IF;
    END LOOP;
END
$$;
