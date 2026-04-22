import type { Handler } from 'aws-lambda';
import { ethers } from 'ethers';
import { sendRewardReport } from './slack';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ValidatorRewardInfo {
  nodeId: string;
  cChainAddress: string;
  ftsoName: string;
  epochId: number;
  validatorRewardFLR: string;
  mirrorRewardFLR: string | null;
  totalRewardFLR: string | null;
  totalStakeFLR: string;
  eligible: boolean;
  stakeEnd: Date;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const FLARE_NODE_IDS  = (process.env.FLARE_NODE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN ?? '';
const GITHUB_API      = process.env.GITHUB_API ?? '';
const GITHUB_RAW      = process.env.GITHUB_RAW ?? '';
const FLR_RPC_URLS    = (process.env.FLR_RPC_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const REWARD_MANAGER  = process.env.REWARD_MANAGER_ADDRESS ?? '0xC8f55c5aA2C752eE285Bd872855C749f4ee6239B';

const SEL_STATE_OF_REWARDS = '0x06c7e243'; // getStateOfRewards(address,uint24)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function matchesNodeId(configured: string, jsonNodeId: string): boolean {
  const c = configured.trim();
  const j = jsonNodeId.trim();
  if (c === j) return true;
  const p = 'NodeID-';
  if (j.startsWith(p) && c === j.slice(p.length)) return true;
  if (c.startsWith(p) && j === c.slice(p.length)) return true;
  return false;
}

function weiToFLR(wei: string): string {
  return (Number(BigInt(wei)) / 1e18).toFixed(2);
}

function nFLRtoFLR(nflr: string): string {
  return (Number(BigInt(nflr)) / 1e9).toLocaleString('en-US');
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  if (GITHUB_TOKEN) h['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function tryEndpoints<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const url of urls) {
    try { return await fn(url); } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`All endpoints failed:\n${errors.join('\n')}`);
}

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result!;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

async function getLatestEpochId(): Promise<number> {
  const res = await fetch(GITHUB_API, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const dirs = (await res.json()) as Array<{ name: string; type: string }>;
  const epochs = dirs
    .filter(d => d.type === 'dir' && d.name.startsWith('reward-epoch-'))
    .map(d => parseInt(d.name.replace('reward-epoch-', ''), 10))
    .filter(n => !isNaN(n));
  if (!epochs.length) throw new Error('No reward epochs found');
  return Math.max(...epochs);
}

async function getMirrorRewardFLR(cChainAddress: string, epochId: number): Promise<string> {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const callData = SEL_STATE_OF_REWARDS +
    abiCoder.encode(['address', 'uint24'], [cChainAddress, epochId]).slice(2);
  const result = await tryEndpoints(FLR_RPC_URLS, rpc => ethCall(rpc, REWARD_MANAGER, callData));
  const [states] = abiCoder.decode(['tuple(uint24,bytes20,uint120,uint8,bool)[]'], result);
  let total = BigInt(0);
  for (const s of states as [bigint, string, bigint, number, boolean][]) {
    if (s[2] > 0n) total += s[2];
  }
  return (Number(total) / 1e18).toFixed(2);
}

interface NodeData {
  nodeId: string;
  ftsoName?: string;
  cChainAddress: string;
  validatorRewardAmount: string;
  totalStakeAmount: string;
  eligible: boolean;
  stakeEnd: number;
}

async function getAllValidatorRewardInfo(): Promise<ValidatorRewardInfo[]> {
  if (!FLARE_NODE_IDS.length) throw new Error('FLARE_NODE_IDS not configured');

  const epochId = await getLatestEpochId();

  const res = await fetch(`${GITHUB_RAW}/reward-epoch-${epochId}/nodes-data.json`);
  if (!res.ok) throw new Error(`Failed to fetch nodes-data.json: ${res.status}`);
  const nodes = (await res.json()) as NodeData[];

  return Promise.all(
    FLARE_NODE_IDS.map(async (nodeId) => {
      const node = nodes.find(n => matchesNodeId(nodeId, n.nodeId));
      if (!node) throw new Error(`Node ${nodeId} not found in epoch ${epochId} data`);

      const validatorRewardFLR = weiToFLR(node.validatorRewardAmount);

      const mirrorRewardFLR = FLR_RPC_URLS.length > 0
        ? await getMirrorRewardFLR(node.cChainAddress, epochId)
        : null;

      const totalRewardFLR = mirrorRewardFLR !== null
        ? (parseFloat(validatorRewardFLR) + parseFloat(mirrorRewardFLR)).toFixed(2)
        : null;

      return {
        nodeId: node.nodeId,
        cChainAddress: node.cChainAddress,
        ftsoName: node.ftsoName ?? '',
        epochId,
        validatorRewardFLR,
        mirrorRewardFLR,
        totalRewardFLR,
        totalStakeFLR: nFLRtoFLR(node.totalStakeAmount),
        eligible: node.eligible,
        stakeEnd: new Date(node.stakeEnd * 1000),
      };
    }),
  );
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export const handler: Handler = async () => {
  const infos = await getAllValidatorRewardInfo();
  for (const info of infos) {
    console.log(JSON.stringify(info, null, 2));
    await sendRewardReport(info);
    console.log(`Reward report sent for ${info.nodeId}`);
  }
};

// ─── Local dev ────────────────────────────────────────────────────────────────

if (require.main === module) {
  Promise.resolve(handler({} as never, {} as never, () => {})).catch(console.error);
}
