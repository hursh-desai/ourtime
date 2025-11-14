// Edge Function: DOB Permits Sync
// Syncs NYC DOB Permit Issuance data from Socrata API
// Supports historical backfill and incremental sync modes

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SOCRATA_BASE_URL = 'https://data.cityofnewyork.us/resource/ipu4-2q9a.json';
const PAGE_SIZE = 5000; // Reduced from 50k for better memory efficiency (one RPC per page)

interface SocrataRecord {
  ':id': string;
  ':created_at': string;
  ':updated_at': string;
  [key: string]: any;
}

interface UpsertResult {
  inserted: number;
  updated: number;
  max_updated: string;
}

Deno.serve(async (req) => {
  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const socrataAppToken = Deno.env.get('SOCRATA_APP_TOKEN');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    // Initialize Supabase client with service role key
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Determine sync mode from query params
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode') || 'incremental';
    const sinceParam = url.searchParams.get('since'); // Custom start date (ISO format)
    const untilParam = url.searchParams.get('until'); // Custom end date (ISO format)

    // Get watermark for incremental sync (if not using custom date range)
    let watermark: string | null = null;
    if (sinceParam) {
      // Use custom since date from query param
      watermark = sinceParam;
    } else if (mode === 'incremental') {
      // Use watermark from database via RPC
      const { data: watermarkData, error: watermarkError } = await supabase
        .rpc('current_dob_watermark');

      if (watermarkError) {
        throw new Error(`Failed to fetch watermark: ${watermarkError.message}`);
      }

      if (watermarkData) {
        watermark = watermarkData;
      }
    }

    // Optional preflight check: skip entire run if nothing new (for incremental mode)
    if (mode === 'incremental' && !sinceParam && !untilParam && watermark) {
      const preflightParams = new URLSearchParams({
        '$select': 'max(:updated_at) as max_updated',
        '$limit': '1',
      });
      preflightParams.append('$where', `:updated_at > '${watermark}'`);

      const preflightHeaders: HeadersInit = {
        'Accept': 'application/json',
      };
      if (socrataAppToken) {
        preflightHeaders['X-App-Token'] = socrataAppToken;
      }

      const preflightResponse = await fetch(
        `${SOCRATA_BASE_URL}?${preflightParams.toString()}`,
        { headers: preflightHeaders }
      );

      if (preflightResponse.ok) {
        const preflightData: Array<{ max_updated?: string }> = await preflightResponse.json();
        if (preflightData.length === 0 || !preflightData[0]?.max_updated) {
          // No new data, return early
          return new Response(
            JSON.stringify({
              success: true,
              mode,
              totalProcessed: 0,
              lastSyncedUpdatedAt: watermark,
              message: 'No new data to sync',
            }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 200,
            }
          );
        }
      }
    }

    // Fetch data from Socrata with pagination and rolling watermark filter
    let page = 0;
    let totalProcessed = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    let newestSeen = watermark || '1970-01-01T00:00:00Z';
    let maxUpdatedAt: string | null = null;

    while (true) {
      // Build query with rolling watermark filter (server-side filtering)
      const pageParams = new URLSearchParams({
        '$select': ':*, *',
        '$order': ':updated_at ASC',
        '$limit': PAGE_SIZE.toString(),
        '$offset': (page * PAGE_SIZE).toString(),
      });

      // Build WHERE clause with rolling watermark
      const whereConditions: string[] = [];
      if (newestSeen) {
        whereConditions.push(`:updated_at > '${newestSeen}'`);
      }
      if (untilParam) {
        whereConditions.push(`:updated_at <= '${untilParam}'`);
      }
      if (whereConditions.length > 0) {
        pageParams.append('$where', whereConditions.join(' AND '));
      }

      const headers: HeadersInit = {
        'Accept': 'application/json',
      };

      if (socrataAppToken) {
        headers['X-App-Token'] = socrataAppToken;
      }

      let response: Response;
      let retries = 3;
      let retryDelay = 1000;

      // Retry logic for transient errors
      while (retries > 0) {
        try {
          response = await fetch(`${SOCRATA_BASE_URL}?${pageParams.toString()}`, {
            headers,
          });

          if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
            if (retries > 1) {
              await new Promise((resolve) => setTimeout(resolve, retryDelay));
              retryDelay *= 2;
              retries--;
              continue;
            }
          }

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `Socrata API error: ${response.status} ${response.statusText}\n${errorText}`
            );
          }

          break;
        } catch (error) {
          if (retries === 1) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          retryDelay *= 2;
          retries--;
        }
      }

      const records: SocrataRecord[] = await response!.json();

      // Early exit if no records returned
      if (!Array.isArray(records) || records.length === 0) {
        break;
      }

      // Upsert entire page via bulk RPC (one RPC call per page)
      const { data: upsertResult, error: upsertError } = await supabase.rpc('upsert_dob_permits', {
        _rows: records,
      });

      if (upsertError) {
        throw new Error(`Upsert failed: ${upsertError.message}`);
      }

      if (upsertResult && upsertResult.length > 0) {
        const result = upsertResult[0] as UpsertResult;
        totalInserted += result.inserted;
        totalUpdated += result.updated;
        
        // Update watermark from RPC return (SQL-computed max)
        if (result.max_updated && result.max_updated > newestSeen) {
          newestSeen = result.max_updated;
          maxUpdatedAt = result.max_updated;
        }
      }

      totalProcessed += records.length;

      // If we got fewer than a full page, we're done
      if (records.length < PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    // Update sync state with high-water mark (only if not using custom date range)
    // Custom date ranges don't update sync state to avoid interfering with incremental sync
    if (!sinceParam && !untilParam && (maxUpdatedAt || mode === 'historical')) {
      const { error: stateError } = await supabase
        .from('dataset_sync_state')
        .upsert({
          dataset_id: 'ipu4-2q9a',
          last_synced_updated_at: maxUpdatedAt || new Date().toISOString(),
        });

      if (stateError) {
        throw new Error(`Failed to update sync state: ${stateError.message}`);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode,
        totalProcessed,
        totalInserted,
        totalUpdated,
        lastSyncedUpdatedAt: maxUpdatedAt,
        dateRange: sinceParam || untilParam ? {
          since: sinceParam || null,
          until: untilParam || null,
        } : null,
        message: `Processed ${totalProcessed} records (${totalInserted} inserted, ${totalUpdated} updated) in ${mode} mode${sinceParam || untilParam ? ` (date range: ${sinceParam || 'start'} to ${untilParam || 'end'})` : ''}`,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error) {
    console.error('Sync error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});

