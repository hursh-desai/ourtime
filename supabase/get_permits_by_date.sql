-- Get permits data for a specific date: 2025-11-12
-- Filters by permit_issuance_date (most common use case)

-- Option 1: Permits issued on 2025-11-12
select 
  id,
  permit_number,
  permit_type,
  permit_status,
  permit_issuance_date,
  job_start_date,
  expiration_date,
  borough,
  bin,
  zipcode,
  community_board,
  council_district,
  nta_name,
  work_type,
  job_type,
  bldg_type,
  residential,
  gis_latitude,
  gis_longitude,
  updated_at,
  raw
from public.dob_permits
where date(permit_issuance_date) = '2025-11-12'
order by permit_issuance_date desc;

-- Option 2: Summary count for 2025-11-12
select 
  count(*) as total_permits,
  count(distinct permit_type) as distinct_permit_types,
  count(distinct borough) as distinct_boroughs,
  count(distinct permit_status) as distinct_statuses
from public.dob_permits
where date(permit_issuance_date) = '2025-11-12';

-- Option 3: Permits grouped by type for 2025-11-12
select 
  permit_type,
  permit_status,
  count(*) as count
from public.dob_permits
where date(permit_issuance_date) = '2025-11-12'
group by permit_type, permit_status
order by count desc;

-- Option 4: Permits by borough for 2025-11-12
select 
  borough,
  count(*) as count
from public.dob_permits
where date(permit_issuance_date) = '2025-11-12'
group by borough
order by count desc;

-- Option 5: If you want to filter by updated_at instead (when records were synced)
-- Uncomment and use this query instead:
/*
select 
  id,
  permit_number,
  permit_type,
  permit_status,
  permit_issuance_date,
  updated_at,
  borough,
  bin,
  zipcode
from public.dob_permits
where date(updated_at) = '2025-11-12'
order by updated_at desc;
*/

-- Option 6: If you want to filter by job_start_date instead
-- Uncomment and use this query instead:
/*
select 
  id,
  permit_number,
  permit_type,
  permit_status,
  permit_issuance_date,
  job_start_date,
  borough,
  bin,
  zipcode
from public.dob_permits
where date(job_start_date) = '2025-11-12'
order by job_start_date desc;
*/

