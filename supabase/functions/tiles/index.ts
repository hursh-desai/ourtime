// Edge Function: Vector Tiles Endpoint
// Serves MVT tiles for DOB permits with time filtering
// Optimized with caching, ETag, guardrails, and proper binary handling

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Helper to convert hex string to ArrayBuffer
function hexToArrayBuffer(hex: string): ArrayBuffer {
  const hexString = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
  }
  return bytes.buffer;
}

// Helper to generate ETag from binary data
function generateETag(data: ArrayBuffer): string {
  // Simple hash function for ETag (using FNV-1a algorithm)
  const bytes = new Uint8Array(data);
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash.toString(16);
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, authorization, apikey',
        'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
      },
    });
  }

  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    // Initialize Supabase client with service role key
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse URL path: /functions/v1/tiles/permits/{z}/{x}/{y} or /tiles/permits/{z}/{x}/{y}
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Find the 'tiles' part in the path (handles both /functions/v1/tiles/... and /tiles/...)
    const tilesIndex = pathParts.indexOf('tiles');
    if (tilesIndex === -1) {
      return new Response('Invalid path. Expected: /tiles/permits/{z}/{x}/{y}', {
        status: 400,
      });
    }

    // Expected after 'tiles': ['permits', z, x, y]
    if (pathParts.length < tilesIndex + 5 || pathParts[tilesIndex + 1] !== 'permits') {
      return new Response('Invalid path. Expected: /tiles/permits/{z}/{x}/{y}', {
        status: 400,
      });
    }

    const z = parseInt(pathParts[tilesIndex + 2], 10);
    const x = parseInt(pathParts[tilesIndex + 3], 10);
    const y = parseInt(pathParts[tilesIndex + 4], 10);

    // Guardrails: reject invalid zoom levels
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
      return new Response('Invalid tile coordinates', { status: 400 });
    }

    if (z < 0 || z > 16) {
      return new Response('Zoom level must be between 0 and 16', { status: 400 });
    }

    // Validate tile coordinates
    const maxCoord = Math.pow(2, z);
    if (x < 0 || x >= maxCoord || y < 0 || y >= maxCoord) {
      return new Response('Tile coordinates out of range', { status: 400 });
    }

    // Parse query params for date filtering
    const dateParam = url.searchParams.get('date');

    // Default to today if not specified
    const now = new Date();
    const defaultDate = now.toISOString().split('T')[0];

    const dateStr = dateParam || defaultDate;

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateStr)) {
      return new Response('Invalid date format. Use YYYY-MM-DD', {
        status: 400,
      });
    }

    // Parse the date to validate it's a valid date
    const dateObj = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(dateObj.getTime())) {
      return new Response('Invalid date format. Use YYYY-MM-DD', {
        status: 400,
      });
    }

    // Use the date string for cache key
    const cacheDate = dateStr;

    // Try cache first
    const { data: cacheData, error: cacheError } = await supabase
      .from('mvt_cache')
      .select('mvt, updated_at')
      .eq('layer', 'permits')
      .eq('z', z)
      .eq('x', x)
      .eq('y', y)
      .eq('since', cacheDate)
      .eq('until', cacheDate)
      .single();

    let tileData: ArrayBuffer | null = null;

    if (!cacheError && cacheData && cacheData.mvt) {
      // Cache hit - convert to ArrayBuffer
      if (typeof cacheData.mvt === 'string') {
        tileData = hexToArrayBuffer(cacheData.mvt);
      } else {
        tileData = cacheData.mvt as ArrayBuffer;
      }
    } else {
      // Cache miss - call tile RPC
      const { data, error } = await supabase.rpc('dob_permit_tiles', {
        z,
        x,
        y,
        date: dateStr,
      });

      if (error) {
        throw new Error(`Tile RPC error: ${error.message}`);
      }

      // Check if tile is empty (null or empty bytea)
      // PostGIS returns '\x' for empty tiles, which is an empty bytea
      // MapLibre can handle empty tiles, so we return them as-is
      if (!data || 
          (typeof data === 'string' && (data === '\\x' || data.length === 0)) ||
          (data instanceof ArrayBuffer && data.byteLength === 0)) {
        // Return empty response - MapLibre handles empty tiles gracefully
        const emptyTile = new Uint8Array(0);
        return new Response(emptyTile, {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.mapbox-vector-tile',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, authorization, apikey',
          },
        });
      }

      // Convert hex string to ArrayBuffer if needed
      if (typeof data === 'string') {
        tileData = hexToArrayBuffer(data);
      } else {
        tileData = data as ArrayBuffer;
      }

      // Store in cache (async, don't wait)
      supabase
        .from('mvt_cache')
        .upsert({
          layer: 'permits',
          z,
          x,
          y,
          since: cacheDate,
          until: cacheDate,
          mvt: typeof data === 'string' ? data : `\\x${Array.from(new Uint8Array(tileData))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')}`,
          updated_at: new Date().toISOString(),
        })
        .then(() => {})
        .catch((err: unknown) => console.error('Cache write error:', err));
    }

    if (!tileData || tileData.byteLength === 0) {
      // Return empty response - MapLibre handles empty tiles gracefully
      const emptyTile = new Uint8Array(0);
      return new Response(emptyTile, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.mapbox-vector-tile',
          'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        },
      });
    }

    // Generate ETag for conditional requests
    const etag = generateETag(tileData);
    const etagHeader = `"${etag}"`;

    // Check If-None-Match header for 304 Not Modified
    const ifNoneMatch = req.headers.get('If-None-Match');
    if (ifNoneMatch === etagHeader) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etagHeader,
          'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        },
      });
    }

    // Return MVT tile with optimized headers
    return new Response(tileData, {
      headers: {
        'Content-Type': 'application/vnd.mapbox-vector-tile',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        'ETag': etagHeader,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
      status: 200,
    });
  } catch (error) {
    console.error('Tile error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Tile error details:', {
      message: errorMessage,
      url: req.url,
      method: req.method,
    });
    return new Response(
      JSON.stringify({
        error: errorMessage,
      }),
      {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        },
        status: 500,
      }
    );
  }
});

