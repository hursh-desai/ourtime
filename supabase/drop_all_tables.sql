-- Script to drop all tables, views, functions, triggers, and sequences from the public schema
-- WARNING: This will permanently delete all data and objects in the public schema!
-- Run with caution: psql $DATABASE_URL -f supabase/drop_all_tables.sql
-- Or via Supabase CLI: supabase db execute --file supabase/drop_all_tables.sql

-- Drop all triggers first (they depend on tables)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
    ) 
    LOOP
        EXECUTE 'DROP TRIGGER IF EXISTS ' || quote_ident(r.trigger_name) || 
                ' ON ' || quote_ident(r.schema_name) || '.' || quote_ident(r.table_name) || ' CASCADE';
    END LOOP;
END $$;

-- Drop all views (they depend on tables)
-- Exclude PostGIS system views: geography_columns, geometry_columns, raster_columns, raster_overviews
DO $$
DECLARE
    r RECORD;
    postgis_views text[] := ARRAY['geography_columns', 'geometry_columns', 'raster_columns', 'raster_overviews'];
BEGIN
    FOR r IN (SELECT schemaname, viewname 
              FROM pg_views 
              WHERE schemaname = 'public'
              AND viewname != ALL(postgis_views)) 
    LOOP
        EXECUTE 'DROP VIEW IF EXISTS ' || quote_ident(r.schemaname) || '.' || quote_ident(r.viewname) || ' CASCADE';
    END LOOP;
END $$;

-- Drop all functions (may depend on tables/types)
-- Exclude PostGIS functions (they belong to the extension)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT n.nspname as schema_name, p.proname as function_name,
               pg_get_function_identity_arguments(p.oid) as args
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        -- Exclude PostGIS functions (they're part of the extension)
        AND NOT EXISTS (
            SELECT 1 
            FROM pg_depend d
            JOIN pg_extension e ON d.refobjid = e.oid
            WHERE d.objid = p.oid
            AND e.extname = 'postgis'
        )
    ) 
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || quote_ident(r.schema_name) || '.' || 
                quote_ident(r.function_name) || '(' || r.args || ') CASCADE';
    END LOOP;
END $$;

-- Drop all tables (CASCADE will also drop dependent objects like indexes, constraints, etc.)
-- Exclude PostGIS system tables: spatial_ref_sys
DO $$
DECLARE
    r RECORD;
    postgis_tables text[] := ARRAY['spatial_ref_sys'];
BEGIN
    FOR r IN (SELECT tablename 
              FROM pg_tables 
              WHERE schemaname = 'public'
              AND tablename != ALL(postgis_tables)) 
    LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
END $$;

-- Drop all sequences (in case any were created independently)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT sequence_name 
              FROM information_schema.sequences 
              WHERE sequence_schema = 'public') 
    LOOP
        EXECUTE 'DROP SEQUENCE IF EXISTS ' || quote_ident(r.sequence_name) || ' CASCADE';
    END LOOP;
END $$;

-- Verify cleanup (excluding PostGIS system objects)
SELECT 
    'Remaining user tables: ' || COUNT(*)::text as status
FROM pg_tables 
WHERE schemaname = 'public'
AND tablename != ALL(ARRAY['spatial_ref_sys'])
UNION ALL
SELECT 
    'Remaining user views: ' || COUNT(*)::text
FROM pg_views 
WHERE schemaname = 'public'
AND viewname != ALL(ARRAY['geography_columns', 'geometry_columns', 'raster_columns', 'raster_overviews'])
UNION ALL
SELECT 
    'Remaining user functions: ' || COUNT(*)::text
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
AND NOT EXISTS (
    SELECT 1 
    FROM pg_depend d
    JOIN pg_extension e ON d.refobjid = e.oid
    WHERE d.objid = p.oid
    AND e.extname = 'postgis'
)
UNION ALL
SELECT 
    'Remaining triggers: ' || COUNT(*)::text
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public'
AND NOT t.tgisinternal;

