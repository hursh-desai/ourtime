-- Migration: Initialize DOB Permits Schema
-- Creates normalized schema with 4 tables: dob_buildings, dob_permit_details, dob_entities, dob_permits
-- Includes GeoJSON Point generation, PostGIS support, indexes, views, and permissions

-- 1. Building & Parcel Context Table
create table if not exists public.dob_buildings (
  bin text primary key, -- Building Identification Number (matches Socrata bin field)
  block text,
  lot text,
  borough text,
  street_name text,
  house_no text,
  bbl text generated always as (
    case 
      when borough is not null and block is not null and lot is not null
      then borough || LPAD(block, 5, '0') || LPAD(lot, 4, '0')
      else null
    end
  ) stored,
  zipcode text,
  census_tract text,
  nta_name text
);

-- Indexes for dob_buildings
create index if not exists idx_dob_buildings_bbl on public.dob_buildings(bbl);
create index if not exists idx_dob_buildings_borough on public.dob_buildings(borough);
create index if not exists idx_dob_buildings_nta_name on public.dob_buildings(nta_name);

-- 2. Permit Details Table
create table if not exists public.dob_permit_details (
  permit_number text primary key, -- Matches Socrata permit_number
  job_number text,
  permit_sequence_no text,
  permit_subtype text,
  filing_status text,
  filing_date timestamptz,
  site_fill text,
  oil_gas text,
  self_cert text,
  special_district_1 text,
  special_district_2 text
);

-- Indexes for dob_permit_details
create index if not exists idx_dob_permit_details_job_number on public.dob_permit_details(job_number);
create index if not exists idx_dob_permit_details_filing_status on public.dob_permit_details(filing_status);

-- 3. People & Entities Table
create table if not exists public.dob_entities (
  entity_id uuid primary key default gen_random_uuid(),
  entity_type text not null, -- 'owner', 'permittee', 'superintendent', etc.
  full_name text,
  business_name text,
  license_type text,
  license_number text,
  phone text,
  address text,
  city text,
  state text,
  zip text
);

-- Indexes for dob_entities
create index if not exists idx_dob_entities_entity_type on public.dob_entities(entity_type);
create index if not exists idx_dob_entities_business_name on public.dob_entities(business_name);
create index if not exists idx_dob_entities_business_name_type on public.dob_entities(business_name, entity_type);

-- Unique constraint to prevent duplicate entities (business_name + entity_type)
-- Note: NULL business_name values are allowed (multiple NULLs allowed in unique constraint)
create unique index if not exists idx_dob_entities_unique_business_type 
  on public.dob_entities(entity_type, business_name) 
  where business_name is not null;

-- Enable PostGIS extension in extensions schema (recommended by Supabase)
create extension if not exists postgis schema extensions;

-- Function to create GeoJSON Point from latitude and longitude
create or replace function public.create_geojson_point(
  lat double precision,
  lon double precision
)
returns jsonb
language plpgsql
immutable
as $$
begin
  if lat is not null and lon is not null 
     and lat between -90 and 90 
     and lon between -180 and 180 then
    return jsonb_build_object(
      'type', 'Point',
      'coordinates', jsonb_build_array(lon, lat)
    );
  else
    return null;
  end if;
end;
$$;

-- 4. Core Spatial-Temporal Table
create table if not exists public.dob_permits (
  id text primary key, -- Socrata :id
  updated_at timestamptz not null, -- Socrata :updated_at
  borough text,
  bin text, -- Soft reference to dob_buildings.bin (no FK constraint)
  gis_latitude double precision,
  gis_longitude double precision,
  community_board text,
  council_district text,
  nta_name text,
  zipcode text,
  permit_issuance_date timestamptz,
  expiration_date timestamptz,
  job_start_date timestamptz,
  permit_status text,
  permit_type text,
  work_type text,
  job_type text,
  bldg_type text,
  residential text,
  dobrundate timestamptz,
  permit_number text, -- Soft reference to dob_permit_details.permit_number (no FK constraint)
  raw jsonb not null -- Full original payload for audit/expansion
);

-- GeoJSON Point column (computed from gis_latitude/gis_longitude)
alter table public.dob_permits
  add column if not exists geojson jsonb
  generated always as (
    public.create_geojson_point(gis_latitude, gis_longitude)
  ) stored;

-- PostGIS geography column for spatial queries
alter table public.dob_permits
  add column if not exists geom geography(POINT, 4326);

-- PostGIS geometry column for optimized tile generation
alter table public.dob_permits
  add column if not exists geom_4326 geometry(Point, 4326);

-- Generated permit_month column for efficient date filtering
alter table public.dob_permits
  add column if not exists permit_month date 
  generated always as (date_trunc('month', permit_issuance_date AT TIME ZONE 'UTC')::date) stored;

-- Indexes for dob_permits
create index if not exists idx_dob_permits_updated_at on public.dob_permits(updated_at);
create index if not exists idx_dob_permits_issuance_date on public.dob_permits(permit_issuance_date);
create index if not exists idx_dob_permits_issuance_date_brin on public.dob_permits using brin(permit_issuance_date);
create index if not exists idx_dob_permits_geojson on public.dob_permits using gin(geojson);
create index if not exists idx_dob_permits_bin on public.dob_permits(bin);
create index if not exists idx_dob_permits_permit_number on public.dob_permits(permit_number);
create index if not exists idx_dob_permits_borough on public.dob_permits(borough);
create index if not exists idx_dob_permits_permit_type on public.dob_permits(permit_type);
create index if not exists idx_dob_permits_permit_status on public.dob_permits(permit_status);
create index if not exists idx_dob_permits_gis_lat_lon on public.dob_permits(gis_latitude, gis_longitude) where gis_latitude is not null and gis_longitude is not null;

-- PostGIS spatial indexes
create index if not exists dob_permits_geom_index
  on public.dob_permits
  using GIST (geom);

create index if not exists dob_permits_gix on public.dob_permits using gist (geom_4326);

-- Date indexes for filtering
create index if not exists dob_permits_issue_date_ix on public.dob_permits (permit_issuance_date);
create index if not exists dob_permits_permit_month_ix on public.dob_permits(permit_month);

-- Composite index for common query pattern (spatial + date)
create index if not exists dob_permits_geom_date_ix 
  on public.dob_permits (permit_issuance_date) 
  where geom_4326 is not null;

-- View with minimal attributes for GeoJSON features (includes PostGIS columns)
create or replace view public.v_dob_permits_pts as
select 
  id,
  permit_type,
  permit_status,
  permit_issuance_date,
  borough,
  geojson,
  geom,
  geom_4326,
  -- Extract readable coordinates from geom column
  -- ST_Y gets latitude, ST_X gets longitude (from geometry)
  ST_Y(geom::geometry) as lat,
  ST_X(geom::geometry) as lon
from public.dob_permits
where geom is not null;

-- Table to track sync state (high-water mark) - kept for backward compatibility
create table if not exists public.dataset_sync_state (
  dataset_id text primary key,
  last_synced_updated_at timestamptz
);

-- MVT cache table for tile caching
create table if not exists public.mvt_cache (
  layer text not null,
  z smallint not null,
  x int not null,
  y int not null,
  since date not null default '1970-01-01',
  until date not null default '9999-12-31',
  mvt bytea not null,
  updated_at timestamptz not null default now(),
  primary key (layer, z, x, y, since, until)
);

create index if not exists mvt_cache_updated_at_ix on public.mvt_cache (updated_at);

-- Function to populate geom and geom_4326 columns from latitude and longitude
-- This will be called via trigger during upsert operations
create or replace function public.populate_geom_from_coords()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  -- Populate both geography (for backward compatibility) and geometry columns
  if NEW.gis_latitude is not null 
     and NEW.gis_longitude is not null
     and NEW.gis_latitude between -90 and 90
     and NEW.gis_longitude between -180 and 180 then
    -- Geography column (backward compatibility)
    NEW.geom := ST_SetSRID(
      ST_Point(NEW.gis_longitude::double precision, NEW.gis_latitude::double precision),
      4326
    )::geography;
    -- Geometry column (optimized for tiles)
    NEW.geom_4326 := ST_SetSRID(
      ST_Point(NEW.gis_longitude::double precision, NEW.gis_latitude::double precision),
      4326
    );
  else
    NEW.geom := null;
    NEW.geom_4326 := null;
  end if;
  return NEW;
end;
$$;

-- Create trigger to automatically populate geom columns on insert/update
drop trigger if exists trigger_populate_geom on public.dob_permits;
create trigger trigger_populate_geom
  before insert or update on public.dob_permits
  for each row
  execute function public.populate_geom_from_coords();

-- Update existing records to populate geom columns (if any exist)
-- Wrap in DO block to ensure proper search path and function resolution
do $$
begin
  -- Set search path to include extensions schema
  set local search_path = public, extensions;
  
  -- Populate geom from lat/lon
  update public.dob_permits
  set geom = ST_SetSRID(
    ST_Point(
      gis_longitude::double precision, 
      gis_latitude::double precision
    ),
    4326
  )::geography
  where gis_latitude is not null 
    and gis_longitude is not null
    and gis_latitude between -90 and 90
    and gis_longitude between -180 and 180
    and geom is null;
  
  -- Populate geom_4326 from geom or lat/lon
  update public.dob_permits
  set geom_4326 = geom::geometry
  where geom_4326 is null
    and geom is not null;
  
  update public.dob_permits
  set geom_4326 = ST_SetSRID(ST_MakePoint(gis_longitude, gis_latitude), 4326)
  where geom_4326 is null
    and gis_longitude is not null 
    and gis_latitude is not null
    and gis_latitude between -90 and 90
    and gis_longitude between -180 and 180;
end $$;

-- Grant necessary permissions
grant usage on schema public to anon, authenticated;
grant select, insert, update on public.dob_buildings to anon, authenticated;
grant select, insert, update on public.dob_permit_details to anon, authenticated;
grant select, insert, update on public.dob_entities to anon, authenticated;
grant select, insert, update on public.dob_permits to anon, authenticated;
grant select, insert, update on public.dataset_sync_state to anon, authenticated;
grant select, insert, update on public.mvt_cache to anon, authenticated;
grant execute on function public.create_geojson_point(double precision, double precision) to anon, authenticated;
grant execute on function public.populate_geom_from_coords() to anon, authenticated;

