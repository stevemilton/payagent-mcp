/**
 * payagent-mcp — MCP server that lets AI agents pay for APIs.
 *
 * Exposes two tools:
 *   - pay_api: Make an HTTP request, automatically handling 402 payments with USDC
 *   - check_budget: Check how much USDC has been spent and remaining budget
 *
 * Configuration via environment variables:
 *   - PAYAGENT_PRIVATE_KEY: Ethereum private key (hex, required)
 *   - PAYAGENT_BUDGET_USDC: Total session budget in USDC (default: 10.00)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ethers } from 'ethers';
import { SpendTracker, handlePaidRequest } from './payment.js';

// ── Config from env ─────────────────────────────────

const privateKey = process.env.PAYAGENT_PRIVATE_KEY;
if (!privateKey) {
  console.error('Error: PAYAGENT_PRIVATE_KEY environment variable is required');
  process.exit(1);
}

const budgetUSDC = parseFloat(process.env.PAYAGENT_BUDGET_USDC ?? '10.00');
const tracker = new SpendTracker(budgetUSDC);

// Derive wallet address for display
const walletAddress = new ethers.Wallet(privateKey).address;

// ── MCP Server ──────────────────────────────────────

const server = new McpServer({
  name: 'payagent',
  version: '1.0.0',
});

// Tool: pay_api
server.tool(
  'pay_api',
  {
    url: z.string().describe('The full URL of the API endpoint to call'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .default('GET')
      .describe('HTTP method'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Additional HTTP headers to include'),
    body: z
      .string()
      .optional()
      .describe('Request body (for POST/PUT/PATCH)'),
    maxPaymentUSDC: z
      .number()
      .default(1.0)
      .describe('Maximum USDC to pay for this single request. Fails if the API charges more.'),
  },
  async ({ url, method, headers, body, maxPaymentUSDC }) => {
    try {
      const result = await handlePaidRequest(url, {
        method,
        headers,
        body,
        privateKey: privateKey!,
        maxPaymentUSDC,
        tracker,
      });

      const summary = result.paid
        ? `Paid $${result.amount} USDC. Budget remaining: $${tracker.remaining.toFixed(2)}`
        : 'No payment required.';

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `HTTP ${result.status}`,
              summary,
              '',
              result.body,
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool: check_budget
server.tool(
  'check_budget',
  {},
  async () => {
    const payments = tracker.history;
    const lines = [
      `Wallet: ${walletAddress}`,
      `Budget: $${budgetUSDC.toFixed(2)} USDC`,
      `Spent:  $${tracker.spent.toFixed(2)} USDC`,
      `Left:   $${tracker.remaining.toFixed(2)} USDC`,
      `Payments: ${payments.length}`,
    ];

    if (payments.length > 0) {
      lines.push('', 'Recent payments:');
      for (const p of payments.slice(-10)) {
        lines.push(`  ${p.timestamp} — $${p.amount} USDC → ${p.url}`);
      }
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

// ── Start ───────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
