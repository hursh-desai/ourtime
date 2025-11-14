-- Migration: Finalize Functions
-- Creates all functions needed for data sync
-- Includes upsert function and watermark helper

-- Main upsert function for normalized schema
-- Handles all 4 tables: dob_buildings, dob_permit_details, dob_entities, dob_permits
-- Returns statistics: inserted count, updated count, and max updated_at timestamp
create or replace function public.upsert_dob_permits(_rows jsonb)
returns table(inserted int, updated int, max_updated timestamptz)
language plpgsql
as $$
declare
  v_ins int;
  v_upd int;
  v_max timestamptz;
begin
  -- Stage CTE: Extract and transform all fields from Socrata records
  -- Note: API uses field names with underscores (zip_code, bin__, house__, job__, permit_si_no, etc.)
  with stage as (
    select
      (r->>':id')::text                    as id,
      (r->>':updated_at')::timestamptz     as updated_at,
      r->>'borough'                        as borough,
      -- bin field: API uses 'bin__' but also check 'bin'
      coalesce(r->>'bin__', r->>'bin')     as bin, -- Keep as text to match dob_buildings.bin
      -- house_no field: API uses 'house__' but also check 'house_no'
      coalesce(r->>'house__', r->>'house_no') as house_no,
      r->>'street_name'                    as street_name,
      -- job_number field: API uses 'job__' but also check 'job_number'
      coalesce(r->>'job__', r->>'job_number') as job_number,
      -- permit_number field: API uses 'permit_si_no' but also check 'permit_number'
      coalesce(r->>'permit_si_no', r->>'permit_number') as permit_number,
      r->>'work_type'                      as work_type,
      r->>'permit_type'                    as permit_type,
      r->>'permit_status'                  as permit_status,
      (r->>'permit_status_date')::date      as permit_status_date,
      -- permit_issuance_date field: API uses 'issuance_date' but also check 'permit_issuance_date'
      coalesce(r->>'issuance_date', r->>'permit_issuance_date') as permit_issuance_date_str,
      (r->>'expiration_date')::date        as expiration_date,
      (r->>'job_start_date')::date         as job_start_date,
      -- zipcode field: API uses 'zip_code' but also check 'zipcode'
      coalesce(r->>'zip_code', r->>'zipcode') as zipcode,
      r->>'bbl'                            as bbl,
      r->>'community_board'                as community_board,
      -- Extract gis_latitude and gis_longitude from raw JSONB
      (r->>'gis_latitude')::double precision as gis_latitude,
      (r->>'gis_longitude')::double precision as gis_longitude,
      -- Extract fields from raw JSONB that may not be direct Socrata fields
      -- council_district field: API uses 'gis_council_district' but also check 'council_district'
      coalesce(r->>'gis_council_district', r->>'council_district') as council_district,
      r->>'nta_name'                       as nta_name,
      r->>'job_type'                       as job_type,
      r->>'bldg_type'                      as bldg_type,
      r->>'residential'                    as residential,
      r->>'dobrundate'                     as dobrundate_str,
      r->>'permit_subtype'                 as permit_subtype,
      r->>'filing_status'                  as filing_status,
      r->>'filing_date'                    as filing_date_str,
      r->>'site_fill'                      as site_fill,
      r->>'oil_gas'                        as oil_gas,
      r->>'self_cert'                      as self_cert,
      r->>'special_district_1'             as special_district_1,
      r->>'special_district_2'             as special_district_2,
      -- permit_sequence_no field: API uses 'permit_sequence__' but also check 'permit_sequence_no'
      coalesce(r->>'permit_sequence__', r->>'permit_sequence_no') as permit_sequence_no,
      -- Entity fields
      r->>'owner_s_business_name'          as owner_business_name,
      r->>'owner_s_first_name'             as owner_first_name,
      r->>'owner_s_last_name'              as owner_last_name,
      r->>'permittee_s_business_name'      as permittee_business_name,
      r->>'permittee_s_first_name'         as permittee_first_name,
      r->>'permittee_s_last_name'          as permittee_last_name,
      r->>'owner_s_phone'                  as owner_phone,
      r->>'permittee_s_phone'              as permittee_phone,
      r->>'owner_s_address'                as owner_address,
      r->>'permittee_s_address'            as permittee_address,
      r->>'owner_s_city'                   as owner_city,
      r->>'permittee_s_city'               as permittee_city,
      r->>'owner_s_state'                  as owner_state,
      r->>'permittee_s_state'              as permittee_state,
      r->>'owner_s_zip'                    as owner_zip,
      r->>'permittee_s_zip'                as permittee_zip,
      r->>'owner_s_license_type'           as owner_license_type,
      r->>'permittee_s_license_type'       as permittee_license_type,
      r->>'owner_s_license_number'         as owner_license_number,
      r->>'permittee_s_license_number'     as permittee_license_number,
      -- Extract block and lot from bbl or raw JSONB
      r->>'block'                          as block,
      r->>'lot'                            as lot,
      -- census_tract field: API uses 'gis_census_tract' but also check 'census_tract'
      coalesce(r->>'gis_census_tract', r->>'census_tract') as census_tract,
      r                                    as raw
    from jsonb_array_elements(_rows) as r
  ),
  -- Step 1: Upsert buildings
  buildings_upsert as (
    insert into public.dob_buildings (
      bin, block, lot, borough, street_name, house_no, zipcode, census_tract, nta_name
    )
    select distinct on (bin)
      bin,
      block,
      lot,
      borough,
      street_name,
      house_no,
      zipcode,
      census_tract,
      nta_name
    from stage
    where bin is not null
    on conflict (bin) do update set
      block = excluded.block,
      lot = excluded.lot,
      borough = excluded.borough,
      street_name = excluded.street_name,
      house_no = excluded.house_no,
      zipcode = excluded.zipcode,
      census_tract = excluded.census_tract,
      nta_name = excluded.nta_name
  ),
  -- Step 2: Upsert permit details
  permit_details_upsert as (
    insert into public.dob_permit_details (
      permit_number, job_number, permit_sequence_no, permit_subtype,
      filing_status, filing_date, site_fill, oil_gas, self_cert,
      special_district_1, special_district_2
    )
    select distinct on (permit_number)
      permit_number,
      job_number,
      permit_sequence_no,
      permit_subtype,
      filing_status,
      case 
        when filing_date_str is not null and filing_date_str != '' 
        then filing_date_str::timestamptz
        else null
      end as filing_date,
      site_fill,
      oil_gas,
      self_cert,
      special_district_1,
      special_district_2
    from stage
    where permit_number is not null
    on conflict (permit_number) do update set
      job_number = excluded.job_number,
      permit_sequence_no = excluded.permit_sequence_no,
      permit_subtype = excluded.permit_subtype,
      filing_status = excluded.filing_status,
      filing_date = excluded.filing_date,
      site_fill = excluded.site_fill,
      oil_gas = excluded.oil_gas,
      self_cert = excluded.self_cert,
      special_district_1 = excluded.special_district_1,
      special_district_2 = excluded.special_district_2
  ),
  -- Step 3: Upsert entities (owners and permittees)
  entities_upsert as (
    insert into public.dob_entities (
      entity_type, full_name, business_name, license_type, license_number,
      phone, address, city, state, zip
    )
    select distinct on (entity_type, business_name)
      entity_type,
      full_name,
      business_name,
      license_type,
      license_number,
      phone,
      address,
      city,
      state,
      zip
    from (
      -- Owner entities
      select 
        'owner' as entity_type,
        trim(coalesce(owner_first_name, '') || ' ' || coalesce(owner_last_name, '')) as full_name,
        nullif(trim(owner_business_name), '') as business_name,
        owner_license_type as license_type,
        owner_license_number as license_number,
        owner_phone as phone,
        owner_address as address,
        owner_city as city,
        owner_state as state,
        owner_zip as zip
      from stage
      where (owner_business_name is not null and trim(owner_business_name) != '')
         or (owner_first_name is not null and trim(owner_first_name) != '')
         or (owner_last_name is not null and trim(owner_last_name) != '')
      -- Permittee entities
      union all
      select 
        'permittee' as entity_type,
        trim(coalesce(permittee_first_name, '') || ' ' || coalesce(permittee_last_name, '')) as full_name,
        nullif(trim(permittee_business_name), '') as business_name,
        permittee_license_type as license_type,
        permittee_license_number as license_number,
        permittee_phone as phone,
        permittee_address as address,
        permittee_city as city,
        permittee_state as state,
        permittee_zip as zip
      from stage
      where (permittee_business_name is not null and trim(permittee_business_name) != '')
         or (permittee_first_name is not null and trim(permittee_first_name) != '')
         or (permittee_last_name is not null and trim(permittee_last_name) != '')
    ) entities
    where (business_name is not null) 
       or (full_name is not null and trim(full_name) != '')
    order by entity_type, business_name nulls last, full_name
    on conflict (entity_type, business_name) where business_name is not null 
    do update set
      full_name = excluded.full_name,
      license_type = excluded.license_type,
      license_number = excluded.license_number,
      phone = excluded.phone,
      address = excluded.address,
      city = excluded.city,
      state = excluded.state,
      zip = excluded.zip
  ),
  -- Step 4: Upsert permits (main table)
  permits_upsert as (
    insert into public.dob_permits (
      id, updated_at, borough, bin, gis_latitude, gis_longitude, community_board,
      council_district, nta_name, zipcode, permit_issuance_date, expiration_date,
      job_start_date, permit_status, permit_type, work_type, job_type, bldg_type,
      residential, dobrundate, permit_number, raw
    )
    select
      id,
      updated_at,
      borough,
      bin,
      gis_latitude,
      gis_longitude,
      community_board,
      council_district,
      nta_name,
      zipcode,
      case 
        when permit_issuance_date_str is not null and permit_issuance_date_str != '' 
        then permit_issuance_date_str::timestamptz
        else null
      end as permit_issuance_date,
      case 
        when expiration_date is not null 
        then expiration_date::timestamptz
        else null
      end as expiration_date,
      case 
        when job_start_date is not null 
        then job_start_date::timestamptz
        else null
      end as job_start_date,
      permit_status,
      permit_type,
      work_type,
      job_type,
      bldg_type,
      residential,
      case 
        when dobrundate_str is not null and dobrundate_str != '' 
        then dobrundate_str::timestamptz
        else null
      end as dobrundate,
      permit_number,
      raw
    from stage
    on conflict (id) do update set
      updated_at = excluded.updated_at,
      borough = excluded.borough,
      bin = excluded.bin,
      gis_latitude = excluded.gis_latitude,
      gis_longitude = excluded.gis_longitude,
      community_board = excluded.community_board,
      council_district = excluded.council_district,
      nta_name = excluded.nta_name,
      zipcode = excluded.zipcode,
      permit_issuance_date = excluded.permit_issuance_date,
      expiration_date = excluded.expiration_date,
      job_start_date = excluded.job_start_date,
      permit_status = excluded.permit_status,
      permit_type = excluded.permit_type,
      work_type = excluded.work_type,
      job_type = excluded.job_type,
      bldg_type = excluded.bldg_type,
      residential = excluded.residential,
      dobrundate = excluded.dobrundate,
      permit_number = excluded.permit_number,
      raw = excluded.raw
    returning (xmax = 0)::int as ins_flag, (xmax <> 0)::int as upd_flag
  )
  select
    coalesce(sum(ins_flag), 0),
    coalesce(sum(upd_flag), 0),
    (select max(updated_at) from stage)
  into v_ins, v_upd, v_max
  from permits_upsert;

  return query select v_ins, v_upd, v_max;
end;
$$;

-- Watermark helper function to get the current max updated_at from the table
-- Used for incremental syncs to determine starting point
create or replace function public.current_dob_watermark()
returns timestamptz
language sql
stable
as $$
  select coalesce(max(updated_at), '1970-01-01'::timestamptz)
  from public.dob_permits;
$$;

-- Optimized pure SQL tile function for MVT generation
-- Following PostGIS MVT generation patterns with zoom-aware simplification
create or replace function public.dob_permit_tiles(
  z int, 
  x int, 
  y int,
  date text default null
) 
returns bytea
language sql
stable
parallel safe
security definer
set search_path = public, extensions
as $$
with params as (
  select 
    ST_TileEnvelope(z, x, y)::geometry as env_3857, 
    4096 as extent, 
    256 as buf
),
src as (
  select
    p.id,
    p.permit_type,
    p.permit_status,
    p.permit_issuance_date,
    p.borough,
    ST_Transform(p.geom_4326, 3857) as g3857
  from public.dob_permits p, params
  where p.geom_4326 is not null
    -- Filter by date: if date is provided, match any timestamp on that date
    -- If date is null, include all permits (no date filtering)
    -- Exclude NULL permit_issuance_date when filtering by a specific date
    and (date is null or (p.permit_issuance_date is not null and p.permit_issuance_date::date = date::date))
    -- bbox filter in 4326 using GiST index, then transform to 3857 for tile geom
    and p.geom_4326 && ST_Transform((select env_3857 from params), 4326)
),
mvtgeom as (
  select
    id, 
    permit_type, 
    permit_status, 
    permit_issuance_date, 
    borough,
    -- Zoom-aware simplification: reduce vertex load at low zooms
    ST_AsMVTGeom(
      case
        when z <= 6  then ST_SnapToGrid(g3857, 64)   -- very coarse
        when z <= 10 then ST_SnapToGrid(g3857, 8)     -- coarse
        else g3857
      end,
      (select env_3857 from params),
      (select extent from params),
      (select buf from params),
      true
    ) as geom
  from src
  where g3857 && (select env_3857 from params)
    and ST_Intersects(g3857, (select env_3857 from params))
)
select coalesce(
  ST_AsMVT(mvtgeom.*, 'permits', (select extent from params), 'geom'), 
  '\x'::bytea
) from mvtgeom;
$$;

-- Function to clean old cache entries (call via cron or manually)
create or replace function public.clean_mvt_cache()
returns int
language plpgsql
security definer
as $$
declare
  deleted_count int;
begin
  delete from public.mvt_cache
  where updated_at < now() - interval '7 days';
  
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Grant execute permissions on functions
grant execute on function public.upsert_dob_permits(jsonb) to anon, authenticated;
grant execute on function public.current_dob_watermark() to anon, authenticated;
grant execute on function public.dob_permit_tiles(int, int, int, text) to anon, authenticated;
grant execute on function public.clean_mvt_cache() to authenticated;

