# CardTrader Utility Scripts

This repository provides utility scripts for interacting with the [CardTrader](https://www.cardtrader.com/) API. These tools are designed to help CardTrader users automate inventory management and pricing analysis.

## Features

- **Inventory Filtering:**  
  Filter your listed cards by price using comparison operators: `greater`, `less`, or `equal`.
- **Secure Credentials:**  
  Uses a `.env` file to store your API token securely.
- **Command Line Interface:**  
  Pass comparison type and price (in cents) as arguments for flexible queries.

## Prerequisites

- **Node.js 18+** (Node.js 22 recommended)
- CardTrader API token

## Setup

1. **Clone the repository:**
```
git clone https://github.com/yourusername/cardtrader-utils.git
cd cardtrader-utils
```

2. **Create a `.env` file** in the project root:
```
API_TOKEN=your_cardtrader_api_token_here
```

3. **.gitignore**  
The `.env` file is already included in `.gitignore` to protect your credentials.

## Usage

Run the script with:

`node script.js [greater|less|equal] [price_in_cents]`

**Examples:**
- `node script.js equal 8` — Find cards listed at exactly 8 cents
- `node script.js greater 10` — Find cards listed for more than 10 cents
- `node script.js less 5` — Find cards listed for less than 5 cents

The script will output the total number of cards matching your criteria.

## Customization

- Scripts can be extended to support additional CardTrader API endpoints or features.
- The repository is compatible with Neovim (NvChad) and Visual Studio Code keybindings[1].

## Security

- **Never commit your `.env` file.**  
  It contains sensitive API credentials.

## License

MIT License

---

For questions, suggestions, or contributions, please open an issue or pull request.
