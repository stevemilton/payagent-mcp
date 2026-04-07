# payagent-mcp

MCP server that lets AI agents pay for APIs using USDC stablecoins via the x402 protocol.

Works with Claude Desktop, Cursor, Windsurf, or any MCP client.

## Setup

Add to your MCP client config:

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "payagent": {
      "command": "npx",
      "args": ["payagent-mcp"],
      "env": {
        "PAYAGENT_PRIVATE_KEY": "0x...",
        "PAYAGENT_BUDGET_USDC": "10.00"
      }
    }
  }
}
```

### Cursor

Edit `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "payagent": {
      "command": "npx",
      "args": ["payagent-mcp"],
      "env": {
        "PAYAGENT_PRIVATE_KEY": "0x...",
        "PAYAGENT_BUDGET_USDC": "10.00"
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "payagent": {
      "command": "npx",
      "args": ["payagent-mcp"],
      "env": {
        "PAYAGENT_PRIVATE_KEY": "0x...",
        "PAYAGENT_BUDGET_USDC": "10.00"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PAYAGENT_PRIVATE_KEY` | Yes | — | Ethereum private key (hex with 0x prefix) |
| `PAYAGENT_BUDGET_USDC` | No | `10.00` | Total session budget in USDC |

## Tools

### `pay_api`

Make an HTTP request to a paid API. Automatically handles HTTP 402 payment challenges by signing USDC payments via the x402 protocol.

**Parameters:**
- `url` (string, required) — The API endpoint URL
- `method` (string, default: "GET") — HTTP method
- `headers` (object, optional) — Additional HTTP headers
- `body` (string, optional) — Request body
- `maxPaymentUSDC` (number, default: 1.0) — Max USDC for this request

**Example prompt:** "Use pay_api to fetch data from https://api.example.com/premium-data"

### `check_budget`

Check how much USDC has been spent so far and remaining budget.

**Parameters:** None

**Example prompt:** "Check my payment budget"

## How It Works

1. Agent calls `pay_api` with a URL
2. If the API returns HTTP 402 Payment Required:
   - Parses the x402 payment requirements (chain, amount, recipient)
   - Signs an EIP-3009 `transferWithAuthorization` using your wallet
   - Retries the request with the signed `X-PAYMENT` header
3. Returns the API response to the agent

Payments use USDC stablecoins on EVM chains (Base, Ethereum, Polygon). Gas is typically sponsored by the API's facilitator — agents pay $0 gas.

## Wallet Setup

1. Generate a wallet:
   ```bash
   node -e "const { ethers } = require('ethers'); const w = ethers.Wallet.createRandom(); console.log('Address:', w.address); console.log('Key:', w.privateKey)"
   ```

2. Fund with USDC on Base (recommended for lowest fees)

3. Set `PAYAGENT_PRIVATE_KEY` in your MCP config

## Related

- [payagent](https://github.com/stevemilton/payagent) — npm package for programmatic use
- [x402 protocol](https://github.com/coinbase/x402) — HTTP 402 payment standard

## License

MIT
