// CardTrader API Types

export interface Game {
  id: number;
  name: string;
  display_name?: string;
}

export interface Expansion {
  id: number;
  game_id: number;
  code: string;
  name: string;
}

export interface Category {
  id: number;
  name: string;
  game_id: number;
}

export interface Blueprint {
  id: number;
  name: string;
  version?: string;
  expansion_id: number;
  category_id: number;
  scryfall_id?: string;
  image_url?: string;
  // Card properties
  properties?: {
    mtg_foil?: boolean;
    mtg_language?: string;
    condition?: string;
    signed?: boolean;
    altered?: boolean;
  };
}

export interface Product {
  id: number;
  blueprint_id: number;
  name_en: string;
  quantity: number;
  price: number; // in dollars (API uses float)
  price_cents: number;
  description?: string;
  properties: {
    condition?: string;
    mtg_language?: string;
    mtg_foil?: boolean;
    signed?: boolean;
    altered?: boolean;
  };
  expansion?: {
    id: number;
    name: string;
    code: string;
  };
  user_data_field?: string;
}

export interface BulkCreateProduct {
  blueprint_id: number;
  price: number; // dollars
  quantity: number;
  description?: string;
  user_data_field?: string;
  properties?: {
    condition?: string;
    mtg_language?: string;
    mtg_foil?: boolean;
    signed?: boolean;
    altered?: boolean;
  };
}

export interface BulkCreateRequest {
  products: BulkCreateProduct[];
}

export interface BulkCreateResponse {
  job_id?: string;
  created?: number;
  errors?: Array<{ index: number; message: string }>;
}

// Row state for the bulk listing table
export interface ListingRow {
  blueprint: Blueprint;
  selected: boolean;
  condition: string;
  language: string;
  quantity: number; // non-foil quantity
  quantityFoil: number; // foil quantity
  price: string; // string for input handling
}

export type Condition = 'Near Mint' | 'Slightly Played' | 'Moderately Played' | 'Played' | 'Heavily Played' | 'Poor';

export const CONDITIONS: Condition[] = [
  'Near Mint',
  'Slightly Played',
  'Moderately Played',
  'Played',
  'Heavily Played',
  'Poor'
];

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'es', name: 'Spanish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ru', name: 'Russian' },
  { code: 'zhs', name: 'Simplified Chinese' },
  { code: 'zht', name: 'Traditional Chinese' },
];
