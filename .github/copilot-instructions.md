# Copilot Instructions for CardTrader Utility Scripts

## Project Overview
Node.js CLI tools for CardTrader API inventory management and sales analytics. Scripts filter inventory by price and analyze sales by expansion set.

## Architecture Pattern
- **Self-contained scripts**: Each `.js` file is an independent CLI tool with its own IIFE (`(async function() {...})()`), not a module system
- **Shared patterns**: Environment config, caching, formatting helpers are duplicated per-script (intentional - keeps scripts standalone)
- **API flow**: CardTrader API v2 → paginated fetch → filter/aggregate → formatted console output

## Environment & Authentication
```bash
# Required in .env (never commit)
API_TOKEN=your_cardtrader_api_token

# Optional overrides (see script defaults)
API_URL=https://api.cardtrader.com/api/v2  # default
VAT_RATE=0.22                               # 22% VAT for fee calculations
PAGE_LIMIT=200                              # pagination size
CACHE_DIR=.cache                            # JSON file cache location
CACHE_TTL_HOURS=168                         # 7 days default
```

## Running Scripts
Always use `dotenvx` to inject environment variables:
```bash
npx dotenvx run -- node cardsofvalue.js greater 99    # cards over 99¢
npx dotenvx run -- node cardsSoldOfSet.js 2024-01-01  # sales since date
```

## Key Patterns

### Price Handling
Prices stored as **cents (integers)**. Convert to USD for display:
```javascript
const getPriceCents = (p) => p.price_cents ?? Math.round((p.price ?? 0) * 100);
const formatUSDFromCents = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
```

### File-based Caching
Scripts cache API responses (categories, expansions) to `.cache/` directory with TTL:
```javascript
const readJsonIfFresh = (file) => { /* returns null if stale or missing */ };
const writeJson = (file, data) => { /* writes to CACHE_DIR */ };
```

### Fee Calculations
CardTrader Zero (CTZ) 8% fee, CardTrader Regular (CTR) 15% fee, plus VAT on fee:
```javascript
const netAfterFees = (totalCents, feeRate) => totalCents * (1 - feeRate * (1 + VAT_RATE));
```

## API Reference
Postman collection in `card_trader_postman_collection.json` documents all endpoints. Key endpoints used:
- `GET /products/export?page=N&limit=200` - paginated inventory
- `GET /orders?sort=date.desc&page=N` - paginated orders
- `GET /categories`, `GET /expansions` - reference data (cached)

## Adding New Scripts
1. Copy structure from `cardsofvalue.js` (env setup, cache helpers, ANSI formatting)
2. Parse CLI args with `process.argv`
3. Paginate API calls until `data.length < PAGE_LIMIT`
4. Use `console.table()` for structured output, ANSI box drawing for summaries
