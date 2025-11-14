# Issues Found and Fixes Applied

## Summary

Based on the database screenshots showing only `dob_permits` and `dob_entities` tables with data, but no data appearing on the map, here are the issues identified and fixes applied:

## Issues Identified

### 1. **Missing Latitude/Longitude Coordinates** ⚠️ CRITICAL
- **Problem**: Records in `dob_permits` likely have NULL `latitude` and `longitude` values
- **Impact**: Without coordinates, the computed `geom` column is NULL, so records don't appear in `v_dob_permits_pts` view
- **Root Cause**: The Socrata API might use different field names for coordinates (e.g., `location_1`, `the_geom`, or nested objects)
- **Fix**: Created migration `0008_fix_missing_coordinates.sql` that:
  - Extracts coordinates from multiple possible field name patterns
  - Updates existing records with coordinates from alternative fields
  - Updates the `upsert_dob_permits()` function to try multiple coordinate extraction patterns

### 2. **Tile Function Path Routing** ⚠️ CRITICAL
- **Problem**: The tiles edge function expected path `/tiles/permits/{z}/{x}/{y}` but the map calls `/functions/v1/tiles/permits/{z}/{x}/{y}`
- **Impact**: Tile requests fail with 400 errors
- **Fix**: Updated `supabase/functions/tiles/index.ts` to handle both path formats by finding the `tiles` segment dynamically

### 3. **Missing permit_issuance_date** ⚠️ MODERATE
- **Problem**: Some records might have NULL `permit_issuance_date`
- **Impact**: The tile function filters by date range, but it already handles NULL dates correctly (includes them)
- **Status**: Already handled correctly in the tile function

### 4. **Missing Tables** ℹ️ INFO
- **Problem**: Screenshots show `dob_permits` and `dob_entities` have data, but `dob_buildings` and `dob_permit_details` are not shown
- **Impact**: These tables are populated by the upsert function, but they're not required for the map to work
- **Status**: Not blocking - these are normalized reference tables

## Files Created/Modified

1. **`supabase/migrations/0008_fix_missing_coordinates.sql`**
   - Creates `extract_coordinates()` helper function
   - Updates existing records with coordinates from alternative field names
   - Updates `upsert_dob_permits()` to extract coordinates from multiple patterns

2. **`supabase/functions/tiles/index.ts`**
   - Fixed path parsing to handle `/functions/v1/tiles/...` format

3. **`diagnose.sql`**
   - Diagnostic queries to check data population

## Next Steps

1. **Run the migration**:
   ```bash
   supabase db push
   ```

2. **Re-run the sync** to populate coordinates:
   ```bash
   curl "https://your-project.supabase.co/functions/v1/dob-permits-sync?since=2024-01-01T00:00:00Z&until=2024-03-31T23:59:59Z"
   ```

3. **Verify data**:
   ```sql
   -- Check if coordinates are now populated
   SELECT COUNT(*) as total, COUNT(latitude) as with_lat, COUNT(longitude) as with_lon, COUNT(geom) as with_geom
   FROM dob_permits;
   
   -- Check view has data
   SELECT COUNT(*) FROM v_dob_permits_pts;
   ```

4. **Redeploy the tiles function**:
   ```bash
   supabase functions deploy tiles
   ```

5. **Test the map**: Open `http://localhost:3000/nyc` and verify points appear

## Diagnostic Queries

Run these queries to check what's missing:

```sql
-- Check coordinate population
SELECT 
  COUNT(*) as total_records,
  COUNT(latitude) as records_with_latitude,
  COUNT(longitude) as records_with_longitude,
  COUNT(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 END) as records_with_both_coords,
  COUNT(geom) as records_with_geometry
FROM dob_permits;

-- Check view has data
SELECT COUNT(*) as records_in_view FROM v_dob_permits_pts;

-- Sample records
SELECT id, permit_type, latitude, longitude, geom IS NOT NULL as has_geometry, permit_issuance_date
FROM dob_permits LIMIT 10;

-- Check raw JSONB for coordinate fields
SELECT 
  id,
  raw->>'latitude' as raw_latitude,
  raw->>'longitude' as raw_longitude,
  raw->'location_1'->>'latitude' as location_1_lat,
  raw->'location_1'->>'longitude' as location_1_lon,
  raw->'the_geom' as the_geom
FROM dob_permits
WHERE latitude IS NULL OR longitude IS NULL
LIMIT 5;
```

