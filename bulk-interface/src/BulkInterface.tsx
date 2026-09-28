import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import type { Expansion, Blueprint, ListingRow, Condition } from './types';
import { CONDITIONS, LANGUAGES } from './types';
import { fetchExpansions, fetchBlueprints, bulkCreateProducts } from './api';
import Scanner from './Scanner';

// Icons as simple SVG components
const TrashIcon = memo(() => (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
));

// High-res, CORS-safe card image from Scryfall (the thumbnail in `image_url` is
// too low-res to upscale into the hover popout without looking stretched).
function scryfallImage(scryfallId: string, version: 'normal' | 'large' = 'normal') {
  return `https://api.scryfall.com/cards/${scryfallId}?format=image&version=${version}`;
}

// Run async tasks with a small concurrency limit, preserving input order.
// Firing every expansion's export at once looks bot-like and trips CardTrader's
// Cloudflare protection; a pool of 2 keeps the request pattern tame.
async function pooledMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Lets a focused quantity input be adjusted by mouse wheel without also
// scrolling the row list — native wheel-to-change on <input type="number">
// doesn't reliably stop the page/container from scrolling underneath it,
// which made it impossible to spin past 1-2 before the cursor moved off
// the input. A non-passive native listener lets us preventDefault reliably
// (React's onWheel is passive and can't).
function useQuantityWheel(onStep: (delta: number) => void) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      onStep(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [onStep]);
  return ref;
}

// Memoized row component - only re-renders when its specific props change
interface CardRowProps {
  row: ListingRow;
  rowIndex: number;
  onUpdate: (blueprintId: number, updates: Partial<ListingRow>) => void;
  onDelete: (blueprintId: number) => void;
}

const CardRow = memo(function CardRow({ row, rowIndex, onUpdate, onDelete }: CardRowProps) {
  const blueprintId = row.blueprint.id;
  // Tab order: qty → foil → next row's qty → foil (interleaved)
  // Prices are skipped (tabIndex -1) since they're set by defaults
  const qtyTabIndex = 1000 + (rowIndex * 2);
  const foilTabIndex = 1000 + (rowIndex * 2) + 1;

  // Hover popout: fetched on first hover (so opening a set doesn't pull a
  // full-size image for every card) and rendered in a body-level portal with
  // fixed positioning, so it can't be clipped by the list's overflow.
  const thumbRef = useRef<HTMLDivElement>(null);
  const [popoutLoaded, setPopoutLoaded] = useState(false);
  const [popoutStyle, setPopoutStyle] = useState<React.CSSProperties | null>(null);
  const popoutSrc = popoutLoaded
    ? (row.blueprint.scryfall_id ? scryfallImage(row.blueprint.scryfall_id) : row.blueprint.image_url)
    : undefined;

  const showPopout = useCallback(() => {
    setPopoutLoaded(true);
    const el = thumbRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const POPOUT_W = 384; // 24rem
    const estH = POPOUT_W / 0.717; // card aspect ~63:88
    const gap = 8;
    // Prefer the right of the thumbnail; flip left if it would overflow.
    let left = r.right + gap;
    if (left + POPOUT_W > window.innerWidth) left = Math.max(gap, r.left - POPOUT_W - gap);
    // Align to the row, but clamp so the image stays fully on-screen.
    let top = r.top;
    const maxTop = window.innerHeight - estH - gap;
    if (top > maxTop) top = Math.max(gap, maxTop);
    setPopoutStyle({ position: 'fixed', left, top, zIndex: 50 });
  }, []);

  const hidePopout = useCallback(() => setPopoutStyle(null), []);

  const qtyWheelRef = useQuantityWheel(useCallback(
    (delta: number) => onUpdate(blueprintId, { quantity: Math.max(0, (row.quantity || 0) + delta) }),
    [blueprintId, onUpdate, row.quantity]
  ));
  const foilWheelRef = useQuantityWheel(useCallback(
    (delta: number) => onUpdate(blueprintId, { quantityFoil: Math.max(0, (row.quantityFoil || 0) + delta) }),
    [blueprintId, onUpdate, row.quantityFoil]
  ));

  return (
    <div 
      className="grid grid-cols-[32px_48px_1fr_100px_100px_100px_100px_100px] gap-3 px-6 py-3 items-center hover:bg-gray-50 text-base"
    >
      <div className="w-6">
        <input
          type="checkbox"
          className="w-5 h-5"
          checked={row.selected}
          onChange={e => onUpdate(blueprintId, { selected: e.target.checked })}
        />
      </div>
      <button 
        className="text-gray-400 hover:text-red-500" 
        title="Delete"
        onClick={() => onDelete(blueprintId)}
      >
        <TrashIcon />
      </button>
      <div className="flex items-center gap-3">
        {row.blueprint.image_url && (
          <div
            ref={thumbRef}
            className="card-thumb-container"
            onMouseEnter={showPopout}
            onMouseLeave={hidePopout}
          >
            <div className="w-16 h-12 overflow-hidden rounded cursor-pointer">
              <img
                src={row.blueprint.image_url}
                alt=""
                className="w-16 object-cover object-top"
              />
            </div>
            {/* Hover preview - full-res Scryfall art, fetched on first hover,
                portaled to <body> with fixed position so the list's overflow
                can't clip it near the bottom of a short list. */}
            {popoutSrc && popoutStyle &&
              createPortal(
                <img
                  src={popoutSrc}
                  alt={row.blueprint.name}
                  className="card-popout"
                  style={popoutStyle}
                />,
                document.body
              )}
          </div>
        )}
        <span className="font-medium truncate text-base">{row.blueprint.name}</span>
        {(row.blueprint.fixed_properties?.collector_number ?? row.blueprint.version) && (
          <span className="text-gray-400 text-sm whitespace-nowrap tabular-nums">
            #{row.blueprint.fixed_properties?.collector_number ?? row.blueprint.version}
          </span>
        )}
      </div>
      <div>
        <select
          className="border rounded px-2 py-1"
          tabIndex={-1}
          value={row.condition}
          onChange={e => onUpdate(blueprintId, { condition: e.target.value })}
        >
          {CONDITIONS.map(c => (
            <option key={c} value={c}>{c.split(' ').map(w => w[0]).join('')}</option>
          ))}
        </select>
      </div>
      <div>
        <select
          className="border rounded px-2 py-1 w-full"
          tabIndex={-1}
          value={row.language}
          onChange={e => onUpdate(blueprintId, { language: e.target.value })}
        >
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
        </select>
      </div>
      <div>
        <input
          ref={qtyWheelRef}
          type="number"
          className="w-full border rounded px-2 py-1 text-center"
          tabIndex={qtyTabIndex}
          value={row.quantity || ''}
          onChange={e => onUpdate(blueprintId, { quantity: parseInt(e.target.value) || 0 })}
          min={0}
        />
      </div>
      <div>
        <input
          ref={foilWheelRef}
          type="number"
          className="w-full border rounded px-2 py-1 text-center bg-yellow-50"
          tabIndex={foilTabIndex}
          value={row.quantityFoil || ''}
          onChange={e => onUpdate(blueprintId, { quantityFoil: parseInt(e.target.value) || 0 })}
          min={0}
        />
      </div>
      <div className="flex items-center">
        <span className="text-gray-400">$</span>
        <input
          type="text"
          className="w-full border rounded px-2 py-1"
          tabIndex={-1}
          value={row.price}
          onChange={e => onUpdate(blueprintId, { price: e.target.value })}
          placeholder="0.00"
        />
      </div>
    </div>
  );
});

export default function BulkInterface() {
  const [expansions, setExpansions] = useState<Expansion[]>(() => {
    const cached = localStorage.getItem('expansionsCache');
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        return [];
      }
    }
    return [];
  });
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  
  // Selection state for the picker (top bar)
  // Multiple expansion support with localStorage persistence
  const [selectedExpansionIds, setSelectedExpansionIds] = useState<number[]>(() => {
    const saved = localStorage.getItem('selectedExpansionIds');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return [];
      }
    }
    return [];
  });
  const [selectedRarity, setSelectedRarity] = useState<string>('All rarities');
  const [expansionSearch, setExpansionSearch] = useState('');
  const [letterFilter, setLetterFilter] = useState(() => {
    return localStorage.getItem('letterFilter') ?? '';
  });
  
  // Working items - the cards you're building up to sell (main table)
  const [workingItems, setWorkingItems] = useState<ListingRow[]>(() => {
    const saved = localStorage.getItem('workingItems');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return [];
      }
    }
    return [];
  });
  
  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sortBy, setSortBy] = useState<'name' | 'number'>('name');
  const [submitting, setSubmitting] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  
  // Default values for new rows (persisted to localStorage)
  const [defaultCondition, setDefaultCondition] = useState<Condition>('Near Mint');
  const [defaultLanguage, setDefaultLanguage] = useState('en');
  const [defaultQuantity, setDefaultQuantity] = useState(() => {
    const saved = localStorage.getItem('defaultQuantity');
    return saved ? parseInt(saved, 10) : 100;
  });
  const [defaultQuantityFoil, setDefaultQuantityFoil] = useState(() => {
    const saved = localStorage.getItem('defaultQuantityFoil');
    return saved ? parseInt(saved, 10) : 0;
  });
  const [defaultPrice, setDefaultPrice] = useState(() => {
    return localStorage.getItem('defaultPrice') ?? '';
  });

  // Persist quantity and price to localStorage
  useEffect(() => {
    localStorage.setItem('defaultQuantity', String(defaultQuantity));
  }, [defaultQuantity]);

  useEffect(() => {
    localStorage.setItem('defaultQuantityFoil', String(defaultQuantityFoil));
  }, [defaultQuantityFoil]);

  useEffect(() => {
    localStorage.setItem('defaultPrice', defaultPrice);
  }, [defaultPrice]);

  // Persist letter filter
  useEffect(() => {
    localStorage.setItem('letterFilter', letterFilter);
  }, [letterFilter]);

  // Persist selected expansions
  useEffect(() => {
    localStorage.setItem('selectedExpansionIds', JSON.stringify(selectedExpansionIds));
  }, [selectedExpansionIds]);

  // Persist working items to localStorage
  useEffect(() => {
    localStorage.setItem('workingItems', JSON.stringify(workingItems));
  }, [workingItems]);

  // Load expansions on mount (use cache, refresh in background)
  useEffect(() => {
    fetchExpansions()
      .then(data => {
        setExpansions(data);
        localStorage.setItem('expansionsCache', JSON.stringify(data));
      })
      .catch(err => {
        // Only show error if we have no cached data
        if (expansions.length === 0) {
          setError(err.message);
        }
      });
  }, [expansions.length]);

  // Filter expansions to Magic: The Gathering (game_id = 1), sort A-Z, and apply search
  const filteredExpansions = useMemo(() => {
    const MAGIC_GAME_ID = 1;
    const searchLower = expansionSearch.toLowerCase();
    return expansions
      .filter(e => e.game_id === MAGIC_GAME_ID)
      .filter(e => 
        !expansionSearch || 
        e.name.toLowerCase().includes(searchLower) ||
        e.code.toLowerCase().includes(searchLower)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [expansions, expansionSearch]);

  // Load blueprints when expansions selected (for the picker)
  useEffect(() => {
    if (selectedExpansionIds.length === 0) {
      setBlueprints([]);
      return;
    }

    setLoading(true);
    setError(null);

    // Fetch blueprints for all selected expansions (throttled to avoid a burst)
    pooledMap(selectedExpansionIds, 2, id => fetchBlueprints(id))
      .then(results => {
        // Merge all blueprints, sorted by name
        const merged = results.flat().sort((a, b) => a.name.localeCompare(b.name));
        setBlueprints(merged);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedExpansionIds]);

  // Get display info for selected expansions
  const selectedExpansionsInfo = useMemo(() => {
    return selectedExpansionIds.map(id => {
      const exp = expansions.find(e => e.id === id);
      return exp ? { id, name: exp.name, code: exp.code } : null;
    }).filter(Boolean) as { id: number; name: string; code: string }[];
  }, [selectedExpansionIds, expansions]);

  // Add/remove expansion from selection
  const toggleExpansion = useCallback((expId: number) => {
    setSelectedExpansionIds(prev => 
      prev.includes(expId) 
        ? prev.filter(id => id !== expId)
        : [...prev, expId]
    );
  }, []);

  // Helper to get next letter
  const getNextLetter = useCallback((current: string): string => {
    const trimmed = current.trim().toLowerCase();
    if (!trimmed) return 'a';
    
    // Single letter: advance to next
    if (trimmed.length === 1 && /[a-z]/.test(trimmed)) {
      if (trimmed === 'z') return ''; // Done!
      return String.fromCharCode(trimmed.charCodeAt(0) + 1);
    }
    
    return ''; // Reset for complex patterns
  }, []);

  // Advance to next letter and auto-add items
  const advanceToNextLetter = useCallback(() => {
    const nextLetter = getNextLetter(letterFilter);
    if (nextLetter) {
      setLetterFilter(nextLetter);
      // Add items for the new letter
      if (blueprints.length > 0) {
        const newRows: ListingRow[] = blueprints
          .filter(bp => bp.name.charAt(0).toLowerCase() === nextLetter)
          .map(bp => ({
            blueprint: bp,
            selected: false,
            condition: defaultCondition,
            language: defaultLanguage,
            quantity: defaultQuantity,
            quantityFoil: defaultQuantityFoil,
            price: defaultPrice,
          }));

        setWorkingItems(prev => {
          const existingIds = new Set(prev.map(r => r.blueprint.id));
          const toAdd = newRows.filter(r => !existingIds.has(r.blueprint.id));
          return [...prev, ...toAdd];
        });
      }
    }
  }, [getNextLetter, letterFilter, blueprints, defaultCondition, defaultLanguage, defaultQuantity, defaultQuantityFoil, defaultPrice]);

  // Add items from selected expansion to working items
  const handleAddItems = useCallback(() => {
    if (blueprints.length === 0) return;

    // Filter blueprints by letter range if specified
    const filterByLetter = (name: string): boolean => {
      if (!letterFilter.trim()) return true;
      
      const firstChar = name.charAt(0).toLowerCase();
      const filter = letterFilter.trim().toLowerCase();
      
      // Single letter: "a" matches names starting with 'a'
      if (filter.length === 1) {
        return firstChar === filter;
      }
      
      // Range patterns
      if (filter.includes('-')) {
        const [start, end] = filter.split('-');
        
        // "-g" means start to g
        if (!start && end) {
          return firstChar <= end;
        }
        // "c-" means c to end
        if (start && !end) {
          return firstChar >= start;
        }
        // "a-c" means a to c inclusive
        if (start && end) {
          return firstChar >= start && firstChar <= end;
        }
      }
      
      return true;
    };

    // Create new rows from blueprints with default values
    const newRows: ListingRow[] = blueprints
      .filter(bp => filterByLetter(bp.name))
      .map(bp => ({
        blueprint: bp,
        selected: false,
        condition: defaultCondition,
        language: defaultLanguage,
        quantity: defaultQuantity,
        quantityFoil: defaultQuantityFoil,
        price: defaultPrice,
      }));

    // Add to working items (avoid duplicates by blueprint id)
    setWorkingItems(prev => {
      const existingIds = new Set(prev.map(r => r.blueprint.id));
      const toAdd = newRows.filter(r => !existingIds.has(r.blueprint.id));
      return [...prev, ...toAdd];
    });
  }, [blueprints, letterFilter, defaultCondition, defaultLanguage, defaultQuantity, defaultQuantityFoil, defaultPrice]);

  // Count of blueprints that will be added (respecting letter filter)
  const filteredBlueprintsCount = useMemo(() => {
    if (!letterFilter.trim()) return blueprints.length;
    
    const filter = letterFilter.trim().toLowerCase();
    return blueprints.filter(bp => {
      const firstChar = bp.name.charAt(0).toLowerCase();
      
      if (filter.length === 1) {
        return firstChar === filter;
      }
      
      if (filter.includes('-')) {
        const [start, end] = filter.split('-');
        if (!start && end) return firstChar <= end;
        if (start && !end) return firstChar >= start;
        if (start && end) return firstChar >= start && firstChar <= end;
      }
      
      return true;
    }).length;
  }, [blueprints, letterFilter]);

  // Sort working items
  const sortedWorkingItems = useMemo(() => {
    const sorted = [...workingItems];
    if (sortBy === 'name') {
      sorted.sort((a, b) => a.blueprint.name.localeCompare(b.blueprint.name));
    }
    return sorted;
  }, [workingItems, sortBy]);

  // Update a single working item row
  const updateRow = useCallback((blueprintId: number, updates: Partial<ListingRow>) => {
    setWorkingItems(prev => prev.map(row => 
      row.blueprint.id === blueprintId ? { ...row, ...updates } : row
    ));
  }, []);

  // Delete a row from working items
  const deleteRow = useCallback((blueprintId: number) => {
    setWorkingItems(prev => prev.filter(row => row.blueprint.id !== blueprintId));
  }, []);

  // Stable cache key for the scanner's pHash index: the loaded expansion set.
  const scanSetId = useMemo(
    () => [...selectedExpansionIds].sort((a, b) => a - b).join('-'),
    [selectedExpansionIds]
  );

  // A scanned card increments the matching row in-place (foil vs non-foil), or
  // appends a new row seeded from the default-row state with a quantity of 1 —
  // the same working state and Sell path as the manual add flow.
  const handleScanMatch = useCallback((blueprintId: number, info: { isFoil: boolean }) => {
    setWorkingItems(prev => {
      const existing = prev.find(r => r.blueprint.id === blueprintId);
      if (existing) {
        return prev.map(r =>
          r.blueprint.id === blueprintId
            ? info.isFoil
              ? { ...r, quantityFoil: r.quantityFoil + 1 }
              : { ...r, quantity: r.quantity + 1 }
            : r
        );
      }
      const bp = blueprints.find(b => b.id === blueprintId);
      if (!bp) return prev; // not part of the loaded set
      const newRow: ListingRow = {
        blueprint: bp,
        selected: false,
        condition: defaultCondition,
        language: defaultLanguage,
        quantity: info.isFoil ? 0 : 1,
        quantityFoil: info.isFoil ? 1 : 0,
        price: defaultPrice,
      };
      return [...prev, newRow];
    });
  }, [blueprints, defaultCondition, defaultLanguage, defaultPrice]);

  // Undo a scanned count: decrement the matching row's foil/non-foil quantity
  // (never below zero). The inverse of handleScanMatch, for stream misreads.
  const handleScanUndo = useCallback((blueprintId: number, info: { isFoil: boolean }) => {
    setWorkingItems(prev =>
      prev.map(r =>
        r.blueprint.id === blueprintId
          ? info.isFoil
            ? { ...r, quantityFoil: Math.max(0, r.quantityFoil - 1) }
            : { ...r, quantity: Math.max(0, r.quantity - 1) }
          : r
      )
    );
  }, []);

  // Delete all selected rows
  const deleteSelected = useCallback(() => {
    setWorkingItems(prev => prev.filter(row => !row.selected));
  }, []);

  // Count selected items
  const selectedCount = useMemo(() => {
    return workingItems.filter(r => r.selected).length;
  }, [workingItems]);

  // Apply defaults to all working items
  const applyDefaultsToAll = useCallback(() => {
    setWorkingItems(prev => prev.map(row => ({
      ...row,
      condition: defaultCondition,
      language: defaultLanguage,
      quantity: defaultQuantity,
      quantityFoil: defaultQuantityFoil,
      price: defaultPrice,
    })));
  }, [defaultCondition, defaultLanguage, defaultQuantity, defaultQuantityFoil, defaultPrice]);

  // Get items ready for submission (have quantity and price)
  const sellableItems = useMemo(() => {
    return workingItems.filter(r => (r.quantity > 0 || r.quantityFoil > 0) && r.price !== '' && parseFloat(r.price) > 0);
  }, [workingItems]);

  // Calculate total value
  const totalValue = useMemo(() => {
    return sellableItems.reduce((sum, item) => sum + (parseFloat(item.price) || 0) * (item.quantity + item.quantityFoil), 0);
  }, [sellableItems]);

  // Submit to CardTrader
  const handleSell = async () => {
    if (sellableItems.length === 0) {
      setError('No items to sell. Set quantity and price for at least one item.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const products = sellableItems.flatMap(item => {
        const result = [];
        if (item.quantity > 0) {
          result.push({
            blueprint_id: item.blueprint.id,
            price: parseFloat(item.price),
            quantity: item.quantity,
            properties: {
              condition: item.condition,
              mtg_language: item.language,
              mtg_foil: false,
            },
          });
        }
        if (item.quantityFoil > 0) {
          result.push({
            blueprint_id: item.blueprint.id,
            price: parseFloat(item.price),
            quantity: item.quantityFoil,
            properties: {
              condition: item.condition,
              mtg_language: item.language,
              mtg_foil: true,
            },
          });
        }
        return result;
      });

      const result = await bulkCreateProducts({ products });
      
      if (result.errors && result.errors.length > 0) {
        setError(`Created with ${result.errors.length} errors`);
      } else {
        // Remove sold items from working list
        const soldIds = new Set(sellableItems.map(s => s.blueprint.id));
        setWorkingItems(prev => prev.filter(row => !soldIds.has(row.blueprint.id)));
        
        // Auto-advance to next letter if using single letter filter
        const nextLetter = getNextLetter(letterFilter);
        if (nextLetter) {
          setLetterFilter(nextLetter);
          alert(`Successfully listed ${products.length} items! Advancing to letter "${nextLetter.toUpperCase()}"`);
        } else if (letterFilter.trim()) {
          alert(`Successfully listed ${products.length} items! All letters complete.`);
          setLetterFilter('');
        } else {
          alert(`Successfully listed ${products.length} items!`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create products');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 pb-32">
      {/* Header */}
      <header className="bg-[#1a1a2e] text-white px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xl font-bold tracking-wider">CARD</span>
            <span className="text-yellow-400 text-xl">▲</span>
            <span className="text-xl font-bold tracking-wider">TRADER</span>
          </div>
          
          {/* Expansion selector with search */}
          <div className="flex-1 max-w-md relative">
            <input
              type="text"
              className="w-full px-4 py-2.5 rounded bg-white text-gray-900 text-base"
              placeholder="Search expansions..."
              value={expansionSearch}
              onChange={e => setExpansionSearch(e.target.value)}
            />
            {expansionSearch && filteredExpansions.length > 0 && (
              <div className="absolute top-full left-0 right-0 bg-white border rounded-b shadow-lg max-h-64 overflow-y-auto z-50">
                {filteredExpansions.slice(0, 20).map(exp => (
                  <button
                    key={exp.id}
                    className={`w-full px-4 py-2 text-left hover:bg-gray-100 text-gray-900 flex items-center justify-between ${
                      selectedExpansionIds.includes(exp.id) ? 'bg-green-50' : ''
                    }`}
                    onClick={() => {
                      toggleExpansion(exp.id);
                      setExpansionSearch('');
                    }}
                  >
                    <span>{exp.name} ({exp.code})</span>
                    {selectedExpansionIds.includes(exp.id) && (
                      <span className="text-green-600 font-bold">✓</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Selected expansion chips - inline */}
          {selectedExpansionsInfo.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {selectedExpansionsInfo.map(exp => (
                <span 
                  key={exp.id}
                  className="inline-flex items-center bg-blue-500 text-white text-sm px-2.5 py-1 rounded font-medium"
                >
                  {exp.code.toUpperCase()}
                  <button
                    className="ml-1.5 hover:text-red-200 text-lg leading-none"
                    onClick={() => toggleExpansion(exp.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {selectedExpansionsInfo.length > 1 && (
                <button
                  className="text-sm text-gray-400 hover:text-red-400 px-1"
                  onClick={() => setSelectedExpansionIds([])}
                >
                  Clear
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 ml-auto">
            {/* Rarity filter */}
            <select
              className="px-3 py-2.5 rounded bg-white text-gray-900 text-base"
              value={selectedRarity}
              onChange={e => setSelectedRarity(e.target.value)}
            >
              <option>All rarities</option>
              <option>Common</option>
              <option>Uncommon</option>
              <option>Rare</option>
              <option>Mythic</option>
            </select>

            {/* Letter filter for adding items */}
            <div className="flex items-center">
              <input
                type="text"
                className="w-14 px-2 py-2.5 rounded-l bg-white text-gray-900 text-base text-center font-mono uppercase"
                placeholder="A"
                value={letterFilter}
                onChange={e => setLetterFilter(e.target.value.toLowerCase())}
                title="Filter by first letter: 'a', 'a-c', 'c-', or '-g'"
              />
              <button
                className="px-2.5 py-2.5 rounded-r bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold"
                onClick={advanceToNextLetter}
                title="Next letter"
              >
                →
              </button>
            </div>

            {/* Add items button */}
            <button
              className="bg-green-500 hover:bg-green-600 text-white px-5 py-2.5 rounded flex items-center gap-2 text-base font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleAddItems}
              disabled={loading || filteredBlueprintsCount === 0}
            >
              <span>+</span>
              Add{letterFilter ? ` "${letterFilter.toUpperCase()}"` : ''} ({filteredBlueprintsCount})
            </button>

            {/* Scan toggle: opens the camera intake panel for the loaded set */}
            <button
              className={`px-5 py-2.5 rounded flex items-center gap-2 text-base font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
                scannerOpen ? 'bg-yellow-400 text-gray-900' : 'bg-white/10 hover:bg-white/20 text-white'
              }`}
              onClick={() => setScannerOpen(o => !o)}
              disabled={blueprints.length === 0}
              title="Scan cards with a webcam"
            >
              <span>◉</span>
              Scan
            </button>
          </div>
        </div>
      </header>

      {/* Toolbar */}
      <div className="bg-white border-b px-6 py-3 flex items-center gap-6">
        <button
          className="px-4 py-2 border rounded hover:bg-gray-50 ml-auto disabled:opacity-50"
          onClick={applyDefaultsToAll}
          disabled={workingItems.length === 0}
        >
          Apply Defaults to All
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-6 py-4 m-6 rounded text-base">
          {error}
          <button className="ml-4 text-red-500 hover:text-red-700 text-lg" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Loading indicator for expansion */}
      {loading && (
        <div className="text-center py-6 text-gray-500 text-base">Loading cards from expansion...</div>
      )}

      {/* Main working items table */}
      <div className="p-6">
        {workingItems.length === 0 ? (
          <div className="text-center py-12 text-gray-500 text-lg">
            Select an expansion and click "Add items" to start building your list
          </div>
        ) : (
          <div className="bg-white rounded shadow overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[32px_48px_1fr_100px_100px_100px_100px_100px] gap-3 px-6 py-3 bg-gray-50 border-b font-medium text-gray-600 items-center">
              <div className="w-6">
                <input
                  type="checkbox"
                  className="w-5 h-5"
                  onChange={e => {
                    const checked = e.target.checked;
                    setWorkingItems(prev => prev.map(r => ({ ...r, selected: checked })));
                  }}
                />
              </div>
              <div>
                <button
                  className="text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
                  title={`Delete selected (${selectedCount})`}
                  onClick={deleteSelected}
                  disabled={selectedCount === 0}
                >
                  <TrashIcon />
                </button>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-16 h-12 flex flex-col justify-center ml-1"></div>{/* Spacer to match card thumbnail */}
                <select 
                  className="border rounded px-2 py-1"
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value as 'name' | 'number')}
                >
                  <option value="name">Name (A-Z)</option>
                  <option value="number">Number</option>
                </select>
              </div>
              <div>
                <select 
                  className="border rounded px-2 py-1"
                  value={defaultCondition}
                  onChange={e => setDefaultCondition(e.target.value as Condition)}
                >
                  {CONDITIONS.map(c => <option key={c} value={c}>{c.split(' ').map(w => w[0]).join('')}</option>)}
                </select>
              </div>
              <div>
                <select 
                  className="border rounded px-2 py-1 w-full"
                  value={defaultLanguage}
                  onChange={e => setDefaultLanguage(e.target.value)}
                >
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
                </select>
              </div>
              <div>
                <input
                  type="number"
                  className="w-full border rounded px-2 py-1 text-center"
                  placeholder="Qty"
                  value={defaultQuantity || ''}
                  onChange={e => setDefaultQuantity(parseInt(e.target.value) || 0)}
                />
              </div>
              <div>
                <input
                  type="number"
                  className="w-full border rounded px-2 py-1 text-center bg-yellow-50"
                  placeholder="Foil"
                  value={defaultQuantityFoil || ''}
                  onChange={e => setDefaultQuantityFoil(parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="flex items-center">
                <span className="text-gray-400">$</span>
                <input
                  type="text"
                  className="w-full border rounded px-2 py-1"
                  placeholder="Price"
                  value={defaultPrice}
                  onChange={e => setDefaultPrice(e.target.value)}
                />
              </div>
            </div>

            {/* Table rows */}
            <div className="divide-y max-h-[calc(100vh-400px)] overflow-y-auto">
              {sortedWorkingItems.map((row, index) => (
                <CardRow
                  key={row.blueprint.id}
                  row={row}
                  rowIndex={index}
                  onUpdate={updateRow}
                  onDelete={deleteRow}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Floating Sell Button */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg px-6 py-4 flex items-center justify-between">
        <div className="text-base text-gray-600">
          <span className="font-medium">{sellableItems.length}</span> items ready to sell
          {sellableItems.length > 0 && (
            <span className="ml-6">
              Total: <span className="font-medium text-green-600">${totalValue.toFixed(2)}</span>
            </span>
          )}
        </div>
        <button
          className="bg-green-500 hover:bg-green-600 text-white px-12 py-4 rounded-lg font-medium text-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3"
          onClick={handleSell}
          disabled={submitting || sellableItems.length === 0}
        >
          {submitting ? 'Submitting...' : 'Sell'}
        </button>
      </div>

      {/* Camera intake panel — feeds scanned cards into the same working list */}
      {scannerOpen && blueprints.length > 0 && (
        <Scanner
          blueprints={blueprints}
          setId={scanSetId}
          onMatch={handleScanMatch}
          onUndo={handleScanUndo}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}
