import type { Handler } from 'aws-lambda';
import { ethers } from 'ethers';
import { sendProviderAlert } from './slack';

// ─── Config ───────────────────────────────────────────────────────────────────

const IDENTITY_ADDRESS = process.env.PROVIDER_IDENTITY_ADDRESS ?? '';
const FLR_RPC_URLS     = (process.env.FLR_RPC_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);

const ENTITY_MANAGER = '0x134b3311C6BdeD895556807a30C7f047D99DfdC2';
const SUBMISSION     = '0x2cA6571Daa15ce734Bbd0Bf27D5C9D16787fc33f';
const ROUND_TOPIC    = ethers.id('NewVotingRoundInitiated()');
const BLOCKS_5MIN    = 250;
const BATCH_SIZE     = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryEndpoints<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const url of urls) {
    try { return await fn(url); } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`All endpoints failed:\n${errors.join('\n')}`);
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  return tryEndpoints(FLR_RPC_URLS, async (url) => {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result!;
  });
}

// ─── EntityManager lookup ─────────────────────────────────────────────────────

async function getSubmitAddresses(): Promise<{ submitAddr: string; submitSigAddr: string }> {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const selector = ethers.id('getVoterAddresses(address)').slice(0, 10);
  const data = selector + abiCoder.encode(['address'], [IDENTITY_ADDRESS]).slice(2);
  const result = await rpcCall<string>('eth_call', [{ to: ENTITY_MANAGER, data }, 'latest']);
  const [submitAddr, submitSigAddr] = abiCoder.decode(['address', 'address', 'address'], result);
  return { submitAddr: submitAddr.toLowerCase(), submitSigAddr: submitSigAddr.toLowerCase() };
}

// ─── Submission scan ──────────────────────────────────────────────────────────

interface ScanResult {
  rounds: number;
  ftsoSubmitted: number;
  fdcSubmitted: number;
}

async function scanSubmissions(submitAddr: string, submitSigAddr: string): Promise<ScanResult> {
  const latest = parseInt(await rpcCall<string>('eth_blockNumber', []), 16);
  const batches = Math.ceil(BLOCKS_5MIN / BATCH_SIZE);

  let rounds = 0, ftsoSubmitted = 0, fdcSubmitted = 0;

  for (let b = 0; b < batches; b++) {
    const to   = latest - b * BATCH_SIZE;
    const from = Math.max(to - BATCH_SIZE + 1, latest - BLOCKS_5MIN + 1);

    const [blocks, logs] = await Promise.all([
      Promise.all(
        Array.from({ length: to - from + 1 }, (_, i) =>
          rpcCall<{ transactions: Array<{ from: string; to: string | null; input: string }> }>(
            'eth_getBlockByNumber', ['0x' + (from + i).toString(16), true]
          )
        )
      ),
      rpcCall<Array<unknown>>('eth_getLogs', [{
        fromBlock: '0x' + from.toString(16),
        toBlock:   '0x' + to.toString(16),
        address: SUBMISSION,
        topics: [ROUND_TOPIC],
      }]),
    ]);

    rounds += (logs ?? []).length;

    for (const block of blocks) {
      if (!block) continue;
      for (const tx of block.transactions) {
        if (tx.to?.toLowerCase() !== SUBMISSION.toLowerCase()) continue;
        if (tx.from.toLowerCase() === submitAddr)    ftsoSubmitted++;
        if (tx.from.toLowerCase() === submitSigAddr) fdcSubmitted++;
      }
    }
  }

  return { rounds, ftsoSubmitted, fdcSubmitted };
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export const handler: Handler = async () => {
  if (!IDENTITY_ADDRESS) throw new Error('PROVIDER_IDENTITY_ADDRESS not configured');

  const { submitAddr, submitSigAddr } = await getSubmitAddresses();
  console.log('submitAddress:    ', submitAddr);
  console.log('submitSigAddress: ', submitSigAddr);

  const { rounds, ftsoSubmitted, fdcSubmitted } = await scanSubmissions(submitAddr, submitSigAddr);
  const ftsoMissed = Math.max(0, rounds * 2 - ftsoSubmitted);
  // FDC only submits when attestation requests exist, so only alert on complete silence
  const fdcMissed  = rounds > 0 && fdcSubmitted === 0 ? 1 : 0;

  console.log(`Rounds: ${rounds} | FTSO: ${ftsoSubmitted}/${rounds * 2} missed=${ftsoMissed} | FDC: ${fdcSubmitted}/${rounds} missed=${fdcMissed}`);

  if (ftsoMissed > 0 || fdcMissed > 0) {
    await sendProviderAlert({ identityAddress: IDENTITY_ADDRESS, rounds, ftsoSubmitted, ftsoMissed, fdcSubmitted, fdcMissed });
    console.log('Provider alert sent');
  }
};

// ─── Local dev ────────────────────────────────────────────────────────────────

if (require.main === module) {
  Promise.resolve(handler({} as never, {} as never, () => {})).catch(console.error);
}
