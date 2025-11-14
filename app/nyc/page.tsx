'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Helper functions for date range slider
const START_DATE = new Date('2020-01-01');
const getEndDate = () => {
  const date = new Date();
  date.setDate(date.getDate() - 1); // Day before present day
  return date;
};

const dateToDayNumber = (date: Date): number => {
  const diffTime = date.getTime() - START_DATE.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
};

const dayNumberToDate = (dayNumber: number): Date => {
  const date = new Date(START_DATE);
  date.setDate(date.getDate() + dayNumber);
  return date;
};

const formatDate = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

export default function NYCPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  
  const endDate = getEndDate();
  const maxDays = dateToDayNumber(endDate);
  
  const [selectedDay, setSelectedDay] = useState<number>(() => {
    return dateToDayNumber(endDate);
  });

  const selectedDate = formatDate(dayNumberToDate(selectedDay));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';

  // Always log on component mount to verify code is running
  useEffect(() => {
    console.log('🚀 NYC Page component mounted');
    console.log('🔵 Selected date:', selectedDate);
    console.log('🔵 Supabase URL:', supabaseUrl || 'NOT SET - Check .env.local');
    console.log('🔵 Anon Key:', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'SET' : 'NOT SET');
  }, []);

  // Fetch sample permits to verify data exists
  useEffect(() => {
    console.log('🔵 useEffect for sample permits - supabaseUrl:', supabaseUrl || 'EMPTY');
    if (!supabaseUrl) {
      console.warn('⚠️ Supabase URL not set! Tiles will not load. Set NEXT_PUBLIC_SUPABASE_URL in .env.local');
      return;
    }
    
    const fetchSamplePermits = async () => {
      try {
        // Try to fetch some permits directly from the database
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (!anonKey) {
          console.warn('⚠️ NEXT_PUBLIC_SUPABASE_ANON_KEY not set, skipping direct database query');
          return;
        }
        
        const response = await fetch(
          `${supabaseUrl}/rest/v1/dob_permits?select=id,permit_number,permit_type,permit_status,permit_issuance_date,borough,gis_latitude,gis_longitude&limit=10&order=permit_issuance_date.desc`,
          {
            headers: {
              'apikey': anonKey,
              'Authorization': `Bearer ${anonKey}`,
            },
          }
        );
        
        if (!response.ok) {
          console.error('❌ Failed to fetch sample permits:', response.status, response.statusText);
          const text = await response.text();
          console.error('❌ Response body:', text);
          return;
        }
        
        const data = await response.json();
        console.log('📋 Sample permits from database:', data);
        console.log('📋 Total sample permits:', data.length);
        
        if (data.length === 0) {
          console.warn('⚠️ No permits found in database!');
        } else {
          console.log('✅ Sample permit:', data[0]);
        }
      } catch (error) {
        console.error('❌ Error fetching sample permits:', error);
      }
    };
    
    fetchSamplePermits();
  }, [supabaseUrl]);

  // Set up fetch interception once to add auth headers
  useEffect(() => {
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const originalFetch = globalThis.fetch;
    
    globalThis.fetch = async (...args) => {
      const url = args[0] as string;
      const options = args[1] || {};
      
      if (typeof url === 'string' && url.includes('/tiles/permits/')) {
        console.log('🌐 Fetching tile:', url);
        
        // Add auth headers if anon key is available
        const headers = new Headers(options.headers);
        if (anonKey) {
          headers.set('Authorization', `Bearer ${anonKey}`);
          headers.set('apikey', anonKey);
        }
        
        const fetchOptions = {
          ...options,
          headers: headers,
        };
        
        try {
          const response = await originalFetch(url, fetchOptions);
          console.log('📥 Tile response:', {
            url,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length'),
          });
          
          // Try to read the response body for debugging (but don't consume it)
          const clonedResponse = response.clone();
          const arrayBuffer = await clonedResponse.arrayBuffer();
          console.log('📦 Tile data size:', arrayBuffer.byteLength, 'bytes');
          
          if (!response.ok) {
            const text = await clonedResponse.text();
            console.error('❌ Tile request failed:', {
              url,
              status: response.status,
              statusText: response.statusText,
              body: text,
            });
          } else if (arrayBuffer.byteLength === 0) {
            console.warn('⚠️ Empty tile response for:', url);
          } else {
            // Check if response is valid MVT (starts with 0x1a)
            const firstByte = new Uint8Array(arrayBuffer)[0];
            if (firstByte === 0x1a) {
              console.log('✅ Valid MVT tile detected');
            } else {
              console.warn('⚠️ Unexpected tile format, first byte:', firstByte.toString(16));
            }
          }
          
          return response;
        } catch (error) {
          console.error('❌ Tile fetch error:', error, 'for URL:', url);
          throw error;
        }
      }
      return originalFetch(...args);
    };
    
    return () => {
      globalThis.fetch = originalFetch;
    };
  }, []);

  useEffect(() => {
    console.log('🗺️ Map initialization useEffect running');
    console.log('🗺️ mapContainer.current:', !!mapContainer.current);
    console.log('🗺️ map.current:', !!map.current);
    
    if (!mapContainer.current || map.current) {
      console.log('🗺️ Skipping map init - container missing or map already exists');
      return;
    }

    console.log('🗺️ Creating new map...');
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    
    // Initialize map with transformRequest to add auth headers
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'carto-positron': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
          },
        },
        layers: [
          {
            id: 'carto-positron-layer',
            type: 'raster',
            source: 'carto-positron',
            minzoom: 0,
            maxzoom: 22,
          },
        ],
      },
      center: [-73.975083, 40.710361], // NYC coordinates
      zoom: 12,
      transformRequest: (url: string, resourceType?: maplibregl.ResourceType) => {
        // Add auth headers to Supabase Edge Function requests
        if (resourceType === 'Tile' && url.includes('/tiles/permits/')) {
          console.log('🌐 TransformRequest: Adding auth headers to:', url);
          return {
            url,
            headers: anonKey ? {
              'Authorization': `Bearer ${anonKey}`,
              'apikey': anonKey,
            } : {},
          };
        }
        // Return undefined to use default behavior for other requests
        return undefined;
      },
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    console.log('🗺️ Tile setup useEffect running');
    console.log('🗺️ map.current:', !!map.current);
    console.log('🗺️ supabaseUrl:', supabaseUrl || 'EMPTY');
    
    if (!map.current) {
      console.warn('⚠️ Map not initialized yet, skipping tile setup');
      return;
    }
    
    if (!supabaseUrl) {
      console.warn('⚠️ Supabase URL not set, skipping tile setup');
      return;
    }

    // Wait for map to be fully loaded before adding sources
    const setupTiles = () => {
      if (!map.current) return;
      
      console.log('🔵 Setting up map with date:', selectedDate);
      console.log('🔵 Supabase URL:', supabaseUrl);

      // Remove existing source and layer if they exist
      if (map.current.getSource('permits')) {
        map.current.removeLayer('permits-layer');
        map.current.removeSource('permits');
      }

      // Build tile URL (auth headers are added via fetch interception)
      const tileUrl = `${supabaseUrl}/functions/v1/tiles/permits/{z}/{x}/{y}.pbf?date=${selectedDate}`;
      console.log('🔵 Tile URL template:', tileUrl);

      // Add vector tile source
      // Note: Auth headers are added via global fetch interception
      map.current.addSource('permits', {
        type: 'vector',
        tiles: [tileUrl],
        minzoom: 0,
        maxzoom: 16,
      });

      // Log when tiles are requested
      map.current.on('sourcedata', (e: any) => {
        if (e.sourceId === 'permits' && e.isSourceLoaded) {
          console.log('✅ Tile source loaded:', e.tile?.tileID);
        }
      });

      // Log tile loading events
      map.current.on('data', (e: any) => {
        if (e.dataType === 'source' && e.sourceId === 'permits') {
          console.log('📊 Source data event:', {
            sourceId: e.sourceId,
            dataType: e.dataType,
            isSourceLoaded: e.isSourceLoaded,
          });
        }
      });

      // Add layer with styling
      map.current.addLayer({
        id: 'permits-layer',
        type: 'circle',
        source: 'permits',
        'source-layer': 'permits',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            3,
            12,
            5,
            14,
            8,
          ],
          'circle-color': [
            'match',
            ['get', 'permit_status'],
            'ISSUED',
            '#22c55e',
            'APPROVED',
            '#3b82f6',
            'PENDING',
            '#f59e0b',
            '#ef4444', // default/other
          ],
          'circle-opacity': 0.7,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Log layer events
      map.current.on('data', (e: any) => {
        if (e.dataType === 'layer' && e.layerId === 'permits-layer') {
          console.log('🎨 Layer data event:', {
            layerId: e.layerId,
            dataType: e.dataType,
          });
        }
      });

      // Log when features are loaded
      map.current.on('idle', () => {
        const features = map.current!.queryRenderedFeatures();
        const permitFeatures = features.filter(f => f.layer?.id === 'permits-layer');
        console.log('🟢 Map idle - Total features:', features.length);
        console.log('🟢 Permit features found:', permitFeatures.length);
        if (permitFeatures.length > 0) {
          console.log('🟢 Sample permit feature:', permitFeatures[0].properties);
        }
      });

      // Add hover effect
      map.current.on('mouseenter', 'permits-layer', (e) => {
        if (e.features && e.features.length > 0) {
          console.log('🖱️ Hovering over permit:', e.features[0].properties);
          map.current!.getCanvas().style.cursor = 'pointer';
        }
      });

      map.current.on('mouseleave', 'permits-layer', () => {
        map.current!.getCanvas().style.cursor = '';
      });

      // Add click popup
      map.current.on('click', 'permits-layer', (e) => {
        if (e.features && e.features.length > 0) {
          const feature = e.features[0];
          const props = feature.properties || {};
          console.log('🖱️ Clicked permit:', props);
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              `
            <div style="padding: 8px;">
              <strong>Permit #${props.permit_number || props.id}</strong><br/>
              Type: ${props.permit_type || 'N/A'}<br/>
              Status: ${props.permit_status || 'N/A'}<br/>
              Borough: ${props.borough || 'N/A'}<br/>
              Issued: ${props.permit_issuance_date || 'N/A'}
            </div>
          `
            )
            .addTo(map.current!);
        }
      });

      // Log errors with detailed information
      map.current.on('error', (e: any) => {
        console.error('❌ Map error:', {
          error: e.error,
          type: e.type,
          sourceId: e.sourceId,
          tile: e.tile ? {
            tileID: e.tile.tileID,
            state: e.tile.state,
            url: e.tile.url,
          } : null,
          isSourceLoaded: e.isSourceLoaded,
        });
        
        // Log tile-specific errors
        if (e.tile && e.tile.url) {
          console.error('❌ Failed tile URL:', e.tile.url);
        }
        
        // Log error message if available
        if (e.error && e.error.message) {
          console.error('❌ Error message:', e.error.message);
        }
      });
    };

    // Check if map is already loaded, otherwise wait for load event
    if (map.current.loaded()) {
      setupTiles();
    } else {
      map.current.once('load', setupTiles);
    }

    // Cleanup: remove load listener if component unmounts or dependencies change
    return () => {
      if (map.current) {
        map.current.off('load', setupTiles);
      }
    };
  }, [selectedDate, supabaseUrl]);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div
        ref={mapContainer}
        style={{ width: '100%', height: '100%' }}
      />
      <div
        style={{
          position: 'absolute',
          top: '20px',
          left: '20px',
          background: 'white',
          padding: '16px',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          zIndex: 1000,
        }}
      >
        <h2 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: 'bold' }}>
          NYC DOB Permits
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '300px' }}>
          <div>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '14px', fontWeight: '500' }}>
                {selectedDate}
              </label>
            </div>
            <div style={{ position: 'relative', padding: '12px 0', height: '24px' }}>
              {/* Background track */}
              <div
                style={{
                  position: 'absolute',
                  width: '100%',
                  height: '6px',
                  background: '#e5e7eb',
                  borderRadius: '3px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 0,
                }}
              />
              {/* Date slider */}
              <input
                type="range"
                min={0}
                max={maxDays}
                value={selectedDay}
                onChange={(e) => {
                  setSelectedDay(parseInt(e.target.value));
                }}
                style={{
                  position: 'absolute',
                  width: '100%',
                  height: '24px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'transparent',
                  zIndex: 2,
                  cursor: 'pointer',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                  margin: 0,
                  padding: 0,
                  outline: 'none',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
              <span>2020-01-01</span>
              <span>{formatDate(endDate)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

