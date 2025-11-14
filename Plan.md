# NYC DOB Permits Pipeline - Implementation Plan

## Overview

Build a production-ready pipeline for NYC DOB Permit Issuance data with:
- Postgres schema with PostGIS for spatial queries
- Supabase Edge Functions for data sync and tile serving
- Next.js App Router with MapLibre for interactive map visualization
- Scheduled daily incremental syncs

## Architecture Components

### 1. Database Schema & Migrations

**Files:**
- `supabase/migrations/0001_init_dob_permits.sql`
- `supabase/migrations/0002_postgis_tiles.sql`

**Implementation Details:**

**Migration 0001:**
- Table `dob_permit_issuance` with thin columns + `raw jsonb`
- Primary key on Socrata `:id`
- Index on `updated_at` for incremental sync queries
- `dataset_sync_state` table for high-water mark tracking
- PL/pgSQL function `upsert_dob_permit_issuance(rows jsonb)` for idempotent upserts
- Grants for anon/authenticated roles

**Migration 0002:**
- Enable PostGIS extension
- Add computed `geom` column (Point, 4326) from lat/lon
- GiST index on geometry for spatial queries
- B-tree index on `permit_issuance_date`
- BRIN index on `permit_issuance_date` for large time-range scans
- View `v_dob_permits_pts` with minimal attributes for tiles
- RPC `dob_permit_tiles(z, x, y, since, until)` returning MVT bytea
- Uses `ST_TileEnvelope`, `ST_AsMVTGeom`, `ST_AsMVT`

### 2. Supabase Edge Functions

**Files:**
- `supabase/functions/dob-permits-sync/index.ts`
- `supabase/functions/tiles/permits/index.ts`

**dob-permits-sync Implementation:**
- Deno runtime with `@supabase/supabase-js@^2`
- Socrata API client with pagination (`$limit=50000`, `$offset`)
- Request `:*, *` to include system fields (`:id`, `:created_at`, `:updated_at`)
- Support `X-App-Token` header if `SOCRATA_APP_TOKEN` env var set
- Two modes: `historical` (full backfill) and `incremental` (from high-water mark)
- Batch upserts (≤5k per chunk) via RPC to avoid payload limits
- Update `dataset_sync_state` with max `:updated_at` after each batch
- Error handling with retry logic for 429/5xx (exponential backoff)
- Log errors and return structured JSON responses

**tiles/permits Implementation:**
- Parse `{z}/{x}/{y}` from URL path
- Parse `since`/`until` from query params (defaults: 30 days ago to now)
- Call `dob_permit_tiles` RPC with parameters
- Return raw PBF with proper MIME type (`application/vnd.mapbox-vector-tile`)
- Cache headers: `public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`
- Return 204 for empty tiles
- Handle hex string conversion from Postgres bytea

### 3. Supabase Configuration

**File:** `supabase/config.toml`

- Register `dob-permits-sync` function with `verify_jwt=false`
- Schedule daily at `0 8 * * *` UTC (08:00 UTC)
- Pass `{"mode":"incremental"}` as payload

### 4. Next.js Application

**Files:**
- `app/nyc/page.tsx`
- `package.json`
- `next.config.js`
- `tsconfig.json`

**Implementation:**
- App Router structure (`app/nyc/page.tsx`)
- MapLibre GL JS for map rendering
- Carto Positron basemap (light theme)
- Two date inputs for `since`/`until` filtering
- Vector tile source pointing to Edge Function endpoint
- Dynamic tile URL updates on date change (removes/re-adds source)
- Map centered on NYC (default viewport: [-73.9712, 40.7831], zoom 11)
- Circle layer with color coding by permit status
- Click popups showing permit details
- Hover effects on points

### 5. Documentation

**Files:**
- `README.md` - Setup, env vars, deploy steps, test checklist, troubleshooting
- `Plan.md` - This file (detailed implementation plan)

## Test Procedures

### 1. Schema Migration Test

**Procedure:**
```bash
supabase db reset
```

**Verification:**
```sql
-- Check tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('dob_permit_issuance', 'dataset_sync_state');

-- Check indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'dob_permit_issuance';

-- Check RPC exists
SELECT proname FROM pg_proc WHERE proname IN ('upsert_dob_permit_issuance', 'dob_permit_tiles');

-- Check PostGIS extension
SELECT PostGIS_version();
```

**Expected:** All tables, indexes, functions, and PostGIS extension exist.

### 2. Historical Backfill Test

**Procedure:**
```bash
curl "http://localhost:54321/functions/v1/dob-permits-sync?mode=historical"
```

**Verification:**
```sql
-- Check record count
SELECT COUNT(*) FROM dob_permit_issuance;

-- Check sync state
SELECT * FROM dataset_sync_state WHERE dataset_id = 'ipu4-2q9a';

-- Verify raw JSONB populated
SELECT id, raw->>'permit_type' FROM dob_permit_issuance LIMIT 5;
```

**Expected:** 
- Large number of records inserted (>100k typical)
- `dataset_sync_state.last_synced_updated_at` set to recent timestamp
- Raw JSONB contains full Socrata record

### 3. Incremental Sync Test

**Procedure:**
```bash
# Run twice to test idempotency
curl "http://localhost:54321/functions/v1/dob-permits-sync?mode=incremental"
curl "http://localhost:54321/functions/v1/dob-permits-sync?mode=incremental"
```

**Verification:**
```sql
-- Check for duplicates (should be zero)
SELECT id, COUNT(*) FROM dob_permit_issuance GROUP BY id HAVING COUNT(*) > 1;

-- Verify high-water mark only advances if new data exists
SELECT last_synced_updated_at FROM dataset_sync_state WHERE dataset_id = 'ipu4-2q9a';
```

**Expected:**
- No duplicate IDs
- Second run processes zero or minimal new records
- High-water mark unchanged if no new data

### 4. Geometry Population Test

**Procedure:**
```sql
SELECT COUNT(*) FROM dob_permit_issuance WHERE geom IS NOT NULL;
SELECT id, ST_AsText(geom), latitude, longitude 
FROM dob_permit_issuance 
WHERE geom IS NOT NULL 
LIMIT 5;
```

**Expected:**
- Significant portion of records have geometry (>50% typical)
- Geometry points match lat/lon values
- Points are valid (within NYC bounds)

### 5. Tile RPC Test

**Procedure:**
```sql
-- Test tile generation
SELECT encode(
  dob_permit_tiles(12, 1205, 1536, '2025-01-01'::timestamptz, '2025-12-31'::timestamptz),
  'hex'
) AS tile_hex;

-- Verify index usage
EXPLAIN ANALYZE
SELECT * FROM v_dob_permits_pts
WHERE geom && ST_TileEnvelope(12, 1205, 1536)
AND permit_issuance_date BETWEEN '2025-01-01' AND '2025-12-31';
```

**Expected:**
- Non-null hex string returned
- EXPLAIN shows GiST index usage on `geom`
- BRIN or B-tree index used for date filter

### 6. Tile Edge Function Test

**Procedure:**
```bash
curl -I "http://localhost:54321/functions/v1/tiles/permits/12/1205/1536?since=2025-01-01&until=2025-12-31"
```

**Verification:**
- Status: 200 OK or 204 No Content
- Content-Type: `application/vnd.mapbox-vector-tile` (if 200)
- Cache-Control header present with correct values

**Expected:**
- 200 with PBF content or 204 if tile empty
- Proper MIME type and cache headers

### 7. Next.js Page Test

**Procedure:**
1. Start dev server: `pnpm dev`
2. Navigate to `http://localhost:3000/nyc`
3. Verify map loads
4. Change date inputs
5. Click on permit points

**Verification:**
- Map renders with basemap
- Permit points visible as colored circles
- Date changes trigger tile reload (check Network tab)
- Click shows popup with permit details
- Points color-coded by status

**Expected:**
- Map loads without errors
- Tiles fetch successfully
- UI is responsive and interactive

### 8. Performance Test

**Procedure:**
```sql
-- Check index usage on time queries
EXPLAIN ANALYZE
SELECT COUNT(*) FROM dob_permit_issuance
WHERE permit_issuance_date BETWEEN '2025-01-01' AND '2025-12-31';

-- Check BRIN usage on large ranges
EXPLAIN ANALYZE
SELECT * FROM dob_permit_issuance
WHERE permit_issuance_date > '2020-01-01';

-- Check spatial index usage
EXPLAIN ANALYZE
SELECT COUNT(*) FROM dob_permit_issuance
WHERE geom && ST_MakeEnvelope(-74.1, 40.6, -73.9, 40.8, 4326);
```

**Expected:**
- B-tree index used for date range queries
- BRIN index used for large time scans
- GiST index used for spatial queries
- Query times reasonable (<1s for typical queries)

## Deployment Steps

### 1. Local Development

```bash
# Initialize Supabase
supabase init
supabase start

# Run migrations
supabase db reset

# Install Next.js deps
pnpm install

# Set env vars
export NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321

# Start dev server
pnpm dev
```

### 2. Remote Deployment

```bash
# Link to Supabase project
supabase link --project-ref your-project-ref

# Push migrations
supabase db push

# Deploy functions
supabase functions deploy dob-permits-sync
supabase functions deploy tiles/permits

# Set secrets
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-key
supabase secrets set SOCRATA_APP_TOKEN=your-token

# Deploy Next.js (Vercel example)
vercel deploy
```

### 3. Initial Data Load

```bash
# Run historical backfill
curl "https://your-project.supabase.co/functions/v1/dob-permits-sync?mode=historical"

# Monitor logs
supabase functions logs dob-permits-sync --follow
```

## Guardrails & Best Practices

### Idempotency
- Upserts use `ON CONFLICT (id) DO UPDATE` to prevent duplicates
- Incremental sync reads high-water mark before querying Socrata
- Sync state updated atomically after successful batch

### Error Handling
- Retry logic for transient Socrata errors (429, 5xx)
- Exponential backoff for rate limits
- Structured error responses with details
- Logging for debugging

### Performance
- Batch upserts (5k rows) to avoid payload limits
- Indexes on critical columns (updated_at, geom, permit_issuance_date)
- BRIN index for large time-range scans
- GiST index for spatial queries
- Cache headers for tiles (CDN-friendly)

### Security
- Service role key only in Edge Functions (server-side)
- `verify_jwt=false` only for scheduled sync function
- Public read access to tiles (anon role)
- No sensitive data exposed in tiles

## Stretch Goals (Future Enhancements)

1. **Partitioning**: Partition `dob_permit_issuance` by `permit_issuance_date` (monthly)
2. **Materialized Views**: MV for last N days, refreshed during daily job
3. **PMTiles Export**: Generate PMTiles for historical data
4. **UI Enhancements**: Legends, borough/work_type filters, clustering
5. **Monitoring**: Add metrics/alerting for sync failures

## Success Criteria

- [x] Schema migrations run successfully
- [x] Historical backfill completes without errors
- [x] Incremental sync is idempotent
- [x] Geometry column populated correctly
- [x] Tile RPC generates valid MVT
- [x] Tile Edge Function returns proper PBF
- [x] Next.js page loads and displays map
- [x] Date filtering updates tiles dynamically
- [x] Indexes used efficiently in queries
- [x] Cache headers present on tile responses

