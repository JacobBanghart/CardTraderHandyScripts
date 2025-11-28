// CardTrader API client
import type { Game, Expansion, Blueprint, BulkCreateRequest, BulkCreateResponse, Category } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'https://api.cardtrader.com/api/v2';
const getToken = () => import.meta.env.VITE_API_TOKEN || '';

// Assumption: Category 1 is singles for MTG. May need to be configurable for other games.
const MTG_SINGLES_CATEGORY_ID = 1;

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  if (!token) {
    throw new Error('API token not configured. Set VITE_API_TOKEN in .env');
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function fetchGames(): Promise<Game[]> {
  return apiFetch<Game[]>('/games');
}

export async function fetchExpansions(): Promise<Expansion[]> {
  return apiFetch<Expansion[]>('/expansions');
}

export async function fetchCategories(): Promise<Category[]> {
  return apiFetch<Category[]>('/categories');
}

export async function fetchBlueprints(expansionId: number): Promise<Blueprint[]> {
  const blueprints = await apiFetch<Blueprint[]>(`/blueprints/export?expansion_id=${expansionId}`);
  // Filter to only include singles (category_id 1), excluding sealed product like dice bags, kits, etc.
  return blueprints.filter(bp => bp.category_id === MTG_SINGLES_CATEGORY_ID);
}

export async function fetchMarketplacePrices(expansionId: number): Promise<Record<number, { min: number; avg: number }>> {
  try {
    const products = await apiFetch<Array<{ blueprint_id: number; price_cents: number }>>(
      `/marketplace/products?expansion_id=${expansionId}`
    );
    
    // Group by blueprint_id and find min/avg
    const grouped: Record<number, number[]> = {};
    for (const p of products) {
      if (!grouped[p.blueprint_id]) grouped[p.blueprint_id] = [];
      grouped[p.blueprint_id].push(p.price_cents);
    }
    
    const result: Record<number, { min: number; avg: number }> = {};
    for (const [id, prices] of Object.entries(grouped)) {
      const min = Math.min(...prices);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      result[Number(id)] = { min, avg };
    }
    return result;
  } catch {
    return {};
  }
}

export async function bulkCreateProducts(request: BulkCreateRequest): Promise<BulkCreateResponse> {
  return apiFetch<BulkCreateResponse>('/products/bulk_create', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function getJobStatus(jobId: string): Promise<{ status: string; progress?: number; errors?: unknown[] }> {
  return apiFetch(`/jobs/${jobId}`);
}
