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

// Helper functions for popup and side panel
const formatDateReadable = (dateStr: string | null | undefined): string => {
  if (!dateStr) return 'N/A';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
};

const getBoroughName = (borough: string | null | undefined): string => {
  if (!borough) return 'N/A';
  const boroughMap: Record<string, string> = {
    '1': 'Manhattan',
    '2': 'Bronx',
    '3': 'Brooklyn',
    '4': 'Queens',
    '5': 'Staten Island',
  };
  return boroughMap[borough] || borough;
};

const getWorkTypeLabel = (workType: string | null | undefined): string => {
  if (!workType) return '';
  const workTypeMap: Record<string, string> = {
    'PL': 'Plumbing',
    'BL': 'Building',
    'MH': 'Mechanical',
    'OT': 'Other',
  };
  return workTypeMap[workType] || workType;
};

const formatWorkSummary = (
  permitType: string | null | undefined,
  workType: string | null | undefined,
  jobType: string | null | undefined
): string => {
  const parts: string[] = [];
  
  if (permitType) {
    parts.push(permitType);
  }
  
  if (jobType) {
    parts.push(jobType);
  }
  
  const workTypeLabel = getWorkTypeLabel(workType);
  if (workTypeLabel) {
    parts.push(workTypeLabel);
  }
  
  return parts.length > 0 ? parts.join(' — ') : 'Permit';
};

const formatAddress = (
  houseNo: string | null | undefined,
  streetName: string | null | undefined,
  zipcode: string | null | undefined
): string => {
  const parts: string[] = [];
  if (houseNo) parts.push(houseNo);
  if (streetName) parts.push(streetName);
  const address = parts.join(' ');
  if (zipcode && address) {
    return `${address}, ${zipcode}`;
  }
  return address || 'Address not available';
};

interface PermitProperties {
  id?: string;
  permit_type?: string;
  permit_status?: string;
  permit_issuance_date?: string;
  borough?: string;
  work_type?: string;
  job_type?: string;
  expiration_date?: string;
  job_start_date?: string;
  nta_name?: string;
  permit_number?: string;
  zipcode?: string;
  house_no?: string;
  street_name?: string;
  filing_date_str?: string;
  filing_status?: string;
  owner_business_name?: string;
  permittee_business_name?: string;
  [key: string]: string | null | undefined;
}

export default function NYCPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Client-side tile cache: Map<url, ArrayBuffer>
  const tileCache = useRef<Map<string, ArrayBuffer>>(new Map());
  const MAX_CACHE_SIZE = 1000; // Keep last 1000 tiles in memory
  
  const endDate = getEndDate();
  const maxDays = dateToDayNumber(endDate);
  
  const [selectedDay, setSelectedDay] = useState<number>(() => {
    return dateToDayNumber(endDate);
  });
  
  const [selectedPermit, setSelectedPermit] = useState<PermitProperties | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

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

  // Set up fetch interception once to add auth headers and client-side caching
  useEffect(() => {
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const originalFetch = globalThis.fetch;
    
    globalThis.fetch = async (...args) => {
      const url = args[0] as string;
      const options = args[1] || {};
      
      if (typeof url === 'string' && url.includes('/tiles/permits/')) {
        // Check client-side cache first
        const cached = tileCache.current.get(url);
        if (cached) {
          console.log('💾 Cache hit for:', url);
          return new Response(cached, {
            headers: {
              'Content-Type': 'application/vnd.mapbox-vector-tile',
            },
          });
        }
        
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
          
          // Clone response to cache it without consuming the original
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
            // Cache successful responses
            tileCache.current.set(url, arrayBuffer);
            
            // Limit cache size by removing oldest entries
            if (tileCache.current.size > MAX_CACHE_SIZE) {
              const firstKey = tileCache.current.keys().next().value;
              if (firstKey !== undefined) {
                tileCache.current.delete(firstKey);
              }
            }
            
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

      // Create sources and layers for dates within ±7 days of selected date
      const DAY_RANGE = 7;
      
      // Remove all existing permit sources and layers first
      for (let offset = -DAY_RANGE; offset <= DAY_RANGE; offset++) {
        const sourceId = `permits-${offset}`;
        const layerId = `permits-layer-${offset}`;
        
        if (map.current.getLayer(layerId)) {
          map.current.removeLayer(layerId);
        }
        if (map.current.getSource(sourceId)) {
          map.current.removeSource(sourceId);
        }
      }

      // Create sources and layers for each date offset
      for (let offset = -DAY_RANGE; offset <= DAY_RANGE; offset++) {
        const targetDay = selectedDay + offset;
        if (targetDay < 0 || targetDay > maxDays) continue;
        
        const date = formatDate(dayNumberToDate(targetDay));
        const sourceId = `permits-${offset}`;
        const layerId = `permits-layer-${offset}`;
        const tileUrl = `${supabaseUrl}/functions/v1/tiles/permits/{z}/{x}/{y}.pbf?date=${date}`;
        
        // Calculate opacity based on distance from selected date
        // Selected date (offset 0) = 0.7 opacity
        // Each day away reduces opacity by ~0.1 (minimum 0.1)
        const baseOpacity = 0.7;
        const opacityStep = 0.08;
        const opacity = Math.max(0.1, baseOpacity - Math.abs(offset) * opacityStep);
        
        // Add source
        map.current.addSource(sourceId, {
          type: 'vector',
          tiles: [tileUrl],
          minzoom: 0,
          maxzoom: 16,
        });
        
        // Add layer with opacity based on distance
        map.current.addLayer({
          id: layerId,
          type: 'circle',
          source: sourceId,
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
            'circle-opacity': opacity,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-opacity': opacity * 0.8, // Slightly more transparent stroke
          },
        });
      }

      console.log(`✅ Created permit layers with varying opacity for ±${DAY_RANGE} days`);

      // Log when features are loaded
      map.current.on('idle', () => {
        const features = map.current!.queryRenderedFeatures();
        const permitFeatures = features.filter(f => f.layer?.id?.startsWith('permits-layer-'));
        console.log('🟢 Map idle - Total features:', features.length);
        console.log('🟢 Permit features found:', permitFeatures.length);
        if (permitFeatures.length > 0) {
          console.log('🟢 Sample permit feature:', permitFeatures[0].properties);
        }
      });

      // Add hover and click effects for all permit layers
      for (let offset = -DAY_RANGE; offset <= DAY_RANGE; offset++) {
        const layerId = `permits-layer-${offset}`;
        
        // Hover effect
        map.current.on('mouseenter', layerId, (e) => {
          if (e.features && e.features.length > 0) {
            console.log('🖱️ Hovering over permit:', e.features[0].properties);
            map.current!.getCanvas().style.cursor = 'pointer';
          }
        });

        map.current.on('mouseleave', layerId, () => {
          map.current!.getCanvas().style.cursor = '';
        });

        // Click popup
        map.current.on('click', layerId, (e) => {
          if (e.features && e.features.length > 0) {
            const feature = e.features[0];
            const props = feature.properties || {} as PermitProperties;
            console.log('🖱️ Clicked permit:', props);
            
            // Format essential popup data
            const workSummary = formatWorkSummary(props.permit_type, props.work_type, props.job_type);
            const address = formatAddress(props.house_no, props.street_name, props.zipcode);
            const boroughName = getBoroughName(props.borough);
            const neighborhood = props.nta_name ? `${props.nta_name}, ${boroughName}` : boroughName;
            
            // Build entities list (max 2)
            const entities: string[] = [];
            if (props.owner_business_name) entities.push(`Owner: ${props.owner_business_name}`);
            if (props.permittee_business_name && entities.length < 2) {
              entities.push(`Permittee: ${props.permittee_business_name}`);
            }
            
            // Format dates
            const issuedDate = formatDateReadable(props.permit_issuance_date);
            const startsDate = formatDateReadable(props.job_start_date);
            const expiresDate = formatDateReadable(props.expiration_date);
            
            // Build popup HTML
            const popupHTML = `
              <div style="padding: 12px; min-width: 280px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px; color: #111827;">
                  ${workSummary}
                </div>
                <div style="font-size: 14px; color: #374151; margin-bottom: 12px;">
                  ${address}<br/>
                  ${neighborhood}
                </div>
                <div style="font-size: 13px; color: #6b7280; margin-bottom: 8px;">
                  <strong style="color: #111827;">Status:</strong> <span style="color: ${props.permit_status === 'ISSUED' ? '#22c55e' : props.permit_status === 'APPROVED' ? '#3b82f6' : '#f59e0b'}">${props.permit_status || 'N/A'}</span>
                  ${props.filing_status ? ` • ${props.filing_status}` : ''}
                </div>
                <div style="font-size: 13px; color: #6b7280; margin-bottom: 8px;">
                  <strong style="color: #111827;">Issued:</strong> ${issuedDate}<br/>
                  ${startsDate !== 'N/A' ? `<strong style="color: #111827;">Starts:</strong> ${startsDate} • ` : ''}
                  ${expiresDate !== 'N/A' ? `<strong style="color: #111827;">Expires:</strong> ${expiresDate}` : ''}
                </div>
                ${entities.length > 0 ? `<div style="font-size: 13px; color: #6b7280; margin-bottom: 8px;">${entities.join('<br/>')}</div>` : ''}
                <div style="font-size: 13px; color: #6b7280; margin-bottom: 8px;">
                  <strong style="color: #111827;">Job #:</strong> ${props.permit_number || props.id || 'N/A'}
                </div>
                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb;">
                  <a href="#" 
                     onclick="window.openSidePanel && window.openSidePanel(); return false;" 
                     style="color: #3b82f6; text-decoration: none; font-size: 13px; font-weight: 500;">
                    → View full permit details
                  </a>
                </div>
              </div>
            `;
            
            // Store permit data for side panel
            setSelectedPermit(props);
            
            // Create popup with click handler for side panel
            const popup = new maplibregl.Popup({ closeOnClick: true, closeButton: true })
              .setLngLat(e.lngLat)
              .setHTML(popupHTML)
              .addTo(map.current!);
            
            // Set up global function to open side panel (called from popup link)
            interface WindowWithSidePanel extends Window {
              openSidePanel?: () => void;
            }
            (window as WindowWithSidePanel).openSidePanel = () => {
              setSidePanelOpen(true);
              popup.remove();
            };
          }
        });
      }

      // Log errors with detailed information
      map.current.on('error', (e: { error?: Error; type?: string; sourceId?: string; tile?: { tileID?: unknown; state?: string; url?: string }; isSourceLoaded?: boolean }) => {
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
  }, [selectedDate, selectedDay, maxDays, supabaseUrl]);

  // Preload tiles for dates within a week before and after to improve responsiveness
  useEffect(() => {
    if (!map.current || !supabaseUrl) return;
    
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!anonKey) return;

    const preloadTilesForDate = (dayOffset: number) => {
      const targetDay = selectedDay + dayOffset;
      if (targetDay < 0 || targetDay > maxDays) return;
      
      const date = formatDate(dayNumberToDate(targetDay));
      const bounds = map.current!.getBounds();
      const zoom = Math.floor(map.current!.getZoom());
      
      // Calculate visible tile range
      const nw = bounds.getNorthWest();
      const se = bounds.getSouthEast();
      
      // Convert lat/lon to tile coordinates
      const tileX1 = Math.floor((nw.lng + 180) / 360 * Math.pow(2, zoom));
      const tileX2 = Math.floor((se.lng + 180) / 360 * Math.pow(2, zoom));
      const tileY1 = Math.floor((1 - Math.log(Math.tan(se.lat * Math.PI / 180) + 1 / Math.cos(se.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
      const tileY2 = Math.floor((1 - Math.log(Math.tan(nw.lat * Math.PI / 180) + 1 / Math.cos(nw.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
      
      // Prefetch visible tiles for this date (limit to reasonable number)
      const tilesToPrefetch: Array<{ z: number; x: number; y: number }> = [];
      for (let x = Math.max(0, tileX1 - 1); x <= Math.min(Math.pow(2, zoom) - 1, tileX2 + 1); x++) {
        for (let y = Math.max(0, tileY1 - 1); y <= Math.min(Math.pow(2, zoom) - 1, tileY2 + 1); y++) {
          tilesToPrefetch.push({ z: zoom, x, y });
        }
      }
      
      // Limit prefetch per date to avoid overwhelming the server
      // Prioritize closer dates (fewer tiles for distant dates)
      const distance = Math.abs(dayOffset);
      const maxPrefetch = distance === 0 ? 20 : Math.max(5, 20 - distance * 2);
      const tilesToLoad = tilesToPrefetch.slice(0, maxPrefetch);
      
      // Prefetch tiles in background
      tilesToLoad.forEach(({ z, x, y }) => {
        const tileUrl = `${supabaseUrl}/functions/v1/tiles/permits/${z}/${x}/${y}.pbf?date=${date}`;
        
        // Only prefetch if not already cached
        if (!tileCache.current.has(tileUrl)) {
          fetch(tileUrl, {
            headers: {
              'Authorization': `Bearer ${anonKey}`,
              'apikey': anonKey,
            },
          })
            .then(async (response) => {
              if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                if (arrayBuffer.byteLength > 0) {
                  tileCache.current.set(tileUrl, arrayBuffer);
                  
                  // Limit cache size
                  if (tileCache.current.size > MAX_CACHE_SIZE) {
                    const firstKey = tileCache.current.keys().next().value;
                    if (firstKey !== undefined) {
                      tileCache.current.delete(firstKey);
                    }
                  }
                  
                  console.log(`🔮 Prefetched tile (${dayOffset >= 0 ? '+' : ''}${dayOffset} days):`, tileUrl);
                }
              }
            })
            .catch((error) => {
              // Silently fail prefetch - it's just an optimization
              console.debug('Prefetch failed (non-critical):', error);
            });
        }
      });
    };

    // Preload tiles for a week before and after (±7 days)
    const WEEK_RANGE = 7;
    for (let offset = -WEEK_RANGE; offset <= WEEK_RANGE; offset++) {
      // Skip the selected date (offset 0) as it's already loaded
      if (offset !== 0) {
        preloadTilesForDate(offset);
      }
    }
  }, [selectedDay, maxDays, supabaseUrl]);

  // Function to render side panel content
  const renderSidePanel = () => {
    if (!selectedPermit) return null;
    
    const props = selectedPermit;
    const workSummary = formatWorkSummary(props.permit_type, props.work_type, props.job_type);
    const address = formatAddress(props.house_no, props.street_name, props.zipcode);
    const boroughName = getBoroughName(props.borough);
    
    return (
      <div style={{
        position: 'fixed',
        top: 0,
        right: sidePanelOpen ? 0 : '-500px',
        width: '480px',
        maxWidth: '90vw',
        height: '100vh',
        background: 'white',
        boxShadow: '-2px 0 8px rgba(0,0,0,0.15)',
        zIndex: 2000,
        transition: 'right 0.3s ease-in-out',
        overflowY: 'auto',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}>
        <div style={{ padding: '24px' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: '0 0 8px 0', fontSize: '20px', fontWeight: '600', color: '#111827' }}>
                {workSummary}
              </h2>
              <div style={{ fontSize: '14px', color: '#6b7280' }}>
                {address}<br/>
                {props.nta_name ? `${props.nta_name}, ${boroughName}` : boroughName}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSidePanelOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '24px',
                cursor: 'pointer',
                color: '#6b7280',
                padding: '4px 8px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          
          {/* Status Section */}
          <div style={{ marginBottom: '24px', paddingBottom: '24px', borderBottom: '1px solid #e5e7eb' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#111827', marginBottom: '12px' }}>Status</h3>
            <div style={{ fontSize: '14px', color: '#374151' }}>
              <div style={{ marginBottom: '8px' }}>
                <strong>Permit Status:</strong> <span style={{ color: props.permit_status === 'ISSUED' ? '#22c55e' : props.permit_status === 'APPROVED' ? '#3b82f6' : '#f59e0b' }}>{props.permit_status || 'N/A'}</span>
              </div>
              {props.filing_status && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Filing Status:</strong> {props.filing_status}
                </div>
              )}
            </div>
          </div>
          
          {/* Dates Section */}
          <div style={{ marginBottom: '24px', paddingBottom: '24px', borderBottom: '1px solid #e5e7eb' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#111827', marginBottom: '12px' }}>Key Dates</h3>
            <div style={{ fontSize: '14px', color: '#374151' }}>
              {props.permit_issuance_date && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Issued:</strong> {formatDateReadable(props.permit_issuance_date)}
                </div>
              )}
              {props.filing_date_str && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Filing Date:</strong> {formatDateReadable(props.filing_date_str)}
                </div>
              )}
              {props.job_start_date && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Job Start:</strong> {formatDateReadable(props.job_start_date)}
                </div>
              )}
              {props.expiration_date && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Expiration:</strong> {formatDateReadable(props.expiration_date)}
                </div>
              )}
            </div>
          </div>
          
          {/* Entities Section */}
          {(props.owner_business_name || props.permittee_business_name) && (
            <div style={{ marginBottom: '24px', paddingBottom: '24px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#111827', marginBottom: '12px' }}>Entities</h3>
              <div style={{ fontSize: '14px', color: '#374151' }}>
                {props.owner_business_name && (
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Owner:</strong> {props.owner_business_name}
                  </div>
                )}
                {props.permittee_business_name && (
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Permittee:</strong> {props.permittee_business_name}
                  </div>
                )}
              </div>
            </div>
          )}
          
          {/* Permit Metadata */}
          <div style={{ marginBottom: '24px', paddingBottom: '24px', borderBottom: '1px solid #e5e7eb' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#111827', marginBottom: '12px' }}>Permit Information</h3>
            <div style={{ fontSize: '14px', color: '#374151' }}>
              {props.permit_number && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Permit #:</strong> {props.permit_number}
                </div>
              )}
              {props.id && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>ID:</strong> {props.id}
                </div>
              )}
              {props.permit_type && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Permit Type:</strong> {props.permit_type}
                </div>
              )}
              {props.job_type && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Job Type:</strong> {props.job_type}
                </div>
              )}
              {props.work_type && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Work Type:</strong> {getWorkTypeLabel(props.work_type) || props.work_type}
                </div>
              )}
            </div>
          </div>
          
          {/* Location Metadata */}
          <div style={{ marginBottom: '24px', paddingBottom: '24px', borderBottom: '1px solid #e5e7eb' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#111827', marginBottom: '12px' }}>Location Details</h3>
            <div style={{ fontSize: '14px', color: '#374151' }}>
              {props.borough && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Borough:</strong> {boroughName}
                </div>
              )}
              {props.nta_name && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>NTA:</strong> {props.nta_name}
                </div>
              )}
              {props.zipcode && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>ZIP Code:</strong> {props.zipcode}
                </div>
              )}
            </div>
          </div>
          
          {/* Note about additional details */}
          <div style={{ fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>
            Additional details may be available in the full permit record.
          </div>
        </div>
      </div>
    );
  };

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
            {/* Backward and Forward buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginBottom: '8px', marginLeft: '20px' }}>
              <button
                type="button"
                onClick={() => {
                  if (selectedDay > 0) {
                    setSelectedDay(selectedDay - 1);
                  }
                }}
                disabled={selectedDay === 0}
                style={{
                  padding: '4px 8px',
                  fontSize: '12px',
                  fontWeight: '500',
                  color: selectedDay === 0 ? '#9ca3af' : '#3b82f6',
                  background: 'white',
                  border: `1px solid ${selectedDay === 0 ? '#e5e7eb' : '#3b82f6'}`,
                  borderRadius: '6px',
                  cursor: selectedDay === 0 ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (selectedDay > 0) {
                    e.currentTarget.style.background = '#eff6ff';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'white';
                }}
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => {
                  if (selectedDay < maxDays) {
                    setSelectedDay(selectedDay + 1);
                  }
                }}
                disabled={selectedDay === maxDays}
                style={{
                  padding: '4px 8px',
                  fontSize: '12px',
                  fontWeight: '500',
                  color: selectedDay === maxDays ? '#9ca3af' : '#3b82f6',
                  background: 'white',
                  border: `1px solid ${selectedDay === maxDays ? '#e5e7eb' : '#3b82f6'}`,
                  borderRadius: '6px',
                  cursor: selectedDay === maxDays ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (selectedDay < maxDays) {
                    e.currentTarget.style.background = '#eff6ff';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'white';
                }}
              >
                →
              </button>
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
      {renderSidePanel()}
      {/* Overlay to close side panel when clicking outside */}
      {sidePanelOpen && (
        <div
          onClick={() => setSidePanelOpen(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.3)',
            zIndex: 1999,
          }}
        />
      )}
    </div>
  );
}

