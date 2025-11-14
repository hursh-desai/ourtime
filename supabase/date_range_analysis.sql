-- Date Range Analysis for DOB Permits Data
-- Shows overall date ranges and daily counts for each date column

-- 1. Overall Date Range Summary
-- Shows min/max dates and total record counts for each date column
select 
  'permit_issuance_date' as date_column,
  min(permit_issuance_date) as min_date,
  max(permit_issuance_date) as max_date,
  count(*) as total_records,
  count(permit_issuance_date) as records_with_date,
  count(*) - count(permit_issuance_date) as records_with_null_date
from public.dob_permits

union all

select 
  'updated_at' as date_column,
  min(updated_at) as min_date,
  max(updated_at) as max_date,
  count(*) as total_records,
  count(updated_at) as records_with_date,
  count(*) - count(updated_at) as records_with_null_date
from public.dob_permits

union all

select 
  'job_start_date' as date_column,
  min(job_start_date) as min_date,
  max(job_start_date) as max_date,
  count(*) as total_records,
  count(job_start_date) as records_with_date,
  count(*) - count(job_start_date) as records_with_null_date
from public.dob_permits

union all

select 
  'expiration_date' as date_column,
  min(expiration_date) as min_date,
  max(expiration_date) as max_date,
  count(*) as total_records,
  count(expiration_date) as records_with_date,
  count(*) - count(expiration_date) as records_with_null_date
from public.dob_permits

union all

select 
  'filing_date' as date_column,
  min(filing_date) as min_date,
  max(filing_date) as max_date,
  count(*) as total_records,
  count(filing_date) as records_with_date,
  count(*) - count(filing_date) as records_with_null_date
from public.dob_permit_details

order by date_column;

-- 2. Daily Counts by Permit Issuance Date (most relevant for permit data)
-- Shows how many permits were issued each day
select 
  date(permit_issuance_date) as date,
  count(*) as permit_count
from public.dob_permits
where permit_issuance_date is not null
group by date(permit_issuance_date)
order by date desc;

-- 3. Daily Counts by Updated At (shows sync activity)
-- Shows when records were last updated/synced
select 
  date(updated_at) as date,
  count(*) as record_count
from public.dob_permits
group by date(updated_at)
order by date desc;

-- 4. Daily Counts by Filing Date
-- Shows when permits were filed
select 
  date(filing_date) as date,
  count(*) as filing_count
from public.dob_permit_details
where filing_date is not null
group by date(filing_date)
order by date desc;

-- 5. Monthly Summary by Permit Issuance Date
-- Aggregated monthly view for easier trend analysis
select 
  date_trunc('month', permit_issuance_date) as month,
  count(*) as permit_count
from public.dob_permits
where permit_issuance_date is not null
group by date_trunc('month', permit_issuance_date)
order by month desc;

-- 6. Yearly Summary by Permit Issuance Date
-- Aggregated yearly view
select 
  date_trunc('year', permit_issuance_date) as year,
  count(*) as permit_count
from public.dob_permits
where permit_issuance_date is not null
group by date_trunc('year', permit_issuance_date)
order by year desc;

