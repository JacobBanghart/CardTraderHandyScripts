# CardTrader Bulk Listing Interface

A React-based clone of CardTrader's bulk listing interface, built for performance optimization and customization.

## Features

- **Expansion browser**: Select game/expansion to view all card blueprints
- **Inline editing**: Set condition, language, foil/signed status, quantity, and price per card
- **Bulk operations**: Apply defaults to all rows, undo/redo support
- **Market prices**: Shows current marketplace prices for reference
- **API integration**: Posts directly to your CardTrader account via `/products/bulk_create`

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure API credentials - copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

3. Edit `.env` with your CardTrader API token:
```
VITE_API_TOKEN=your_cardtrader_api_token_here
```

4. Start the dev server:
```bash
npm run dev
```

## API Configuration

The interface uses these CardTrader API endpoints:
- `GET /games` - List available games
- `GET /expansions` - List all expansions
- `GET /blueprints/export?expansion_id=X` - Get card blueprints for an expansion
- `GET /marketplace/products?expansion_id=X` - Get market prices
- `POST /products/bulk_create` - Create multiple product listings

## Tech Stack

- **Vite** + **React 19** + **TypeScript**
- **Tailwind CSS** for styling
- Direct API calls (no backend proxy needed with CORS)
