/**
 * payagent-mcp — Self-contained x402 payment handler.
 *
 * Handles: parse 402 → resolve EIP-712 domain → sign → encode → retry.
 * Inlined from payagent to avoid circular npm dependency before publish.
 */
import { ethers } from 'ethers';

// ── Types ───────────────────────────────────────────

interface X402Accept {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  asset: string;
  payTo: string;
  extra?: { name: string; version: string };
}

interface PaymentReceipt {
  url: string;
  amount: string;
  amountBaseUnits: string;
  network: string;
  payTo: string;
  timestamp: string;
}

// ── Constants ───────────────────────────────────────

const USDC_DECIMALS = 6;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// ── Helpers ─────────────────────────────────────────

function baseUnitsToUSDC(baseUnits: string): number {
  return Number(BigInt(baseUnits)) / 10 ** USDC_DECIMALS;
}

function formatUSDC(n: number): string {
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

function chainIdFromNetwork(network: string): number {
  const parts = network.split(':');
  if (parts.length !== 2 || parts[0] !== 'eip155') {
    throw new Error(`Unsupported network: ${network}`);
  }
  const id = parseInt(parts[1], 10);
  if (isNaN(id)) throw new Error(`Invalid chain ID in network: ${network}`);
  return id;
}

// ── Parse 402 ───────────────────────────────────────

function extractAccepts(body: Record<string, unknown>): X402Accept[] {
  // Standard x402 v2 format with accepts array
  if ('accepts' in body && Array.isArray(body.accepts)) {
    return body.accepts as X402Accept[];
  }
  // AgFac flat format
  if ('scheme' in body && 'payTo' in body && !('accepts' in body)) {
    const flat = body as Record<string, unknown>;
    return [{
      scheme: 'exact',
      network: flat.network as string,
      maxAmountRequired: flat.maxAmountRequired as string,
      resource: flat.resource as string,
      asset: flat.asset as string,
      payTo: flat.payTo as string,
      extra: { name: 'USDC', version: '2' },
    }];
  }
  throw new Error('Unrecognized 402 payment requirements format');
}

async function parseRequirements(response: Response): Promise<X402Accept[]> {
  let body: Record<string, unknown>;
  try {
    const json = await response.json();
    body = json.requirements ?? json;
  } catch {
    throw new Error('402 response body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || body.x402Version !== 2) {
    throw new Error('Missing x402Version: 2 in 402 response');
  }
  return extractAccepts(body);
}

// ── Sign ────────────────────────────────────────────

async function signPayment(accept: X402Accept, wallet: ethers.Wallet): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const authorization = {
    from: wallet.address,
    to: accept.payTo,
    value: accept.maxAmountRequired,
    validAfter: (now - 60).toString(),
    validBefore: (now + 480).toString(),
    nonce,
  };

  const domain = {
    name: accept.extra?.name === 'USDC' ? 'USD Coin' : (accept.extra?.name ?? 'USD Coin'),
    version: accept.extra?.version ?? '2',
    chainId: chainIdFromNetwork(accept.network),
    verifyingContract: ethers.getAddress(accept.asset),
  };

  const signature = await wallet.signTypedData(
    domain,
    { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization] },
    {
      from: ethers.getAddress(authorization.from),
      to: ethers.getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  );

  const payload = {
    x402Version: 2,
    payload: { signature, authorization },
    accepted: accept,
    resource: accept.resource,
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// ── Spend Tracker ───────────────────────────────────

export class SpendTracker {
  private totalSpent = 0;
  private readonly budget: number;
  private receipts: PaymentReceipt[] = [];

  constructor(budgetUSDC: number) {
    this.budget = budgetUSDC;
  }

  checkPayment(amountBaseUnits: string): void {
    const amountUSDC = baseUnitsToUSDC(amountBaseUnits);
    if (this.totalSpent + amountUSDC > this.budget) {
      const remaining = this.budget - this.totalSpent;
      throw new Error(
        `Payment of $${formatUSDC(amountUSDC)} USDC would exceed budget. ` +
        `Remaining: $${formatUSDC(remaining)} USDC`,
      );
    }
  }

  recordPayment(receipt: PaymentReceipt): void {
    this.totalSpent += baseUnitsToUSDC(receipt.amountBaseUnits);
    this.receipts.push(receipt);
  }

  get spent(): number { return this.totalSpent; }
  get remaining(): number { return Math.max(0, this.budget - this.totalSpent); }
  get history(): readonly PaymentReceipt[] { return this.receipts; }
}

// ── Main: handle 402 flow ───────────────────────────

export async function handlePaidRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    privateKey: string;
    maxPaymentUSDC?: number;
    tracker: SpendTracker;
  },
): Promise<{ status: number; body: string; paid: boolean; amount?: string }> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  };

  const response = await fetch(url, init);

  if (response.status !== 402) {
    return {
      status: response.status,
      body: await response.text(),
      paid: false,
    };
  }

  // Parse 402
  const accepts = await parseRequirements(response);
  if (accepts.length === 0) {
    throw new Error('No payment options in 402 response');
  }

  const accept = accepts[0];
  const amountUSDC = baseUnitsToUSDC(accept.maxAmountRequired);

  // Check per-request max
  if (options.maxPaymentUSDC !== undefined && amountUSDC > options.maxPaymentUSDC) {
    throw new Error(
      `API charges $${formatUSDC(amountUSDC)} USDC but maxPaymentUSDC is $${formatUSDC(options.maxPaymentUSDC)}`,
    );
  }

  // Check budget
  options.tracker.checkPayment(accept.maxAmountRequired);

  // Sign and retry
  const wallet = new ethers.Wallet(options.privateKey);
  const paymentHeader = await signPayment(accept, wallet);

  const retryHeaders = new Headers(init.headers as HeadersInit | undefined);
  retryHeaders.set('X-PAYMENT', paymentHeader);

  const paidResponse = await fetch(url, { ...init, headers: retryHeaders });

  if (paidResponse.status === 402) {
    throw new Error('Server returned 402 after payment was signed and sent');
  }

  // Record spend
  const receipt: PaymentReceipt = {
    url,
    amount: formatUSDC(amountUSDC),
    amountBaseUnits: accept.maxAmountRequired,
    network: accept.network,
    payTo: accept.payTo,
    timestamp: new Date().toISOString(),
  };
  options.tracker.recordPayment(receipt);

  return {
    status: paidResponse.status,
    body: await paidResponse.text(),
    paid: true,
    amount: receipt.amount,
  };
}
