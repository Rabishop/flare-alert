import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Handler } from 'aws-lambda';
import { sendUptimeAlert, type UptimeAlertInfo } from './slack';

// ─── Config ───────────────────────────────────────────────────────────────────

const FLARE_NODE_IDS  = (process.env.FLARE_NODE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const FLR_PCHAIN_URLS = (process.env.FLR_PCHAIN_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN ?? '';
const GITHUB_API      = process.env.GITHUB_API ?? '';
const GITHUB_RAW      = process.env.GITHUB_RAW ?? '';
const SNAPSHOT_PATH   = process.env.UPTIME_SNAPSHOT_PATH ?? '/tmp/uptime-snapshot.json';

// Flare C-Chain block time is approximately 2 seconds
const BLOCK_TIME_SECONDS = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PChainValidator {
  nodeID: string;
  startTime: string;
  uptime: string;   // percentage string, e.g. "99.9800"
  connected: boolean;
}

interface UptimeSnapshot {
  [nodeId: string]: {
    uptime: number;
    totalSeconds: number;
    capturedAt: number;
  };
}

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

async function tryEndpoints<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const url of urls) {
    try { return await fn(url); } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`All P-Chain endpoints failed:\n${errors.join('\n')}`);
}

// ─── GitHub / C-Chain address lookup ─────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  if (GITHUB_TOKEN) h['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function getCChainAddressMap(): Promise<Map<string, string>> {
  const res = await fetch(GITHUB_API, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const dirs = (await res.json()) as Array<{ name: string; type: string }>;
  const epochId = Math.max(...dirs
    .filter(d => d.type === 'dir' && d.name.startsWith('reward-epoch-'))
    .map(d => parseInt(d.name.replace('reward-epoch-', ''), 10))
    .filter(n => !isNaN(n)));

  const nodesRes = await fetch(`${GITHUB_RAW}/reward-epoch-${epochId}/nodes-data.json`);
  if (!nodesRes.ok) throw new Error(`Failed to fetch nodes-data.json: ${nodesRes.status}`);
  const nodes = (await nodesRes.json()) as Array<{ nodeId: string; cChainAddress: string }>;

  return new Map(nodes.map(n => [n.nodeId, n.cChainAddress]));
}

// ─── P-Chain Query ────────────────────────────────────────────────────────────

async function getCurrentValidators(): Promise<PChainValidator[]> {
  return tryEndpoints(FLR_PCHAIN_URLS, async (url) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'platform.getCurrentValidators',
        params: {},
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      result?: { validators: PChainValidator[] };
      error?: { message: string };
    };
    if (json.error) throw new Error(json.error.message);
    return json.result!.validators;
  });
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

function loadSnapshot(): UptimeSnapshot {
  if (!existsSync(SNAPSHOT_PATH)) return {};
  try { return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')); } catch { return {}; }
}

function saveSnapshot(snap: UptimeSnapshot): void {
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function checkAllUptimes(): Promise<void> {
  if (!FLR_PCHAIN_URLS.length) {
    console.log('FLR_PCHAIN_URLS not configured, skipping uptime check');
    return;
  }

  const [validators, cChainMap] = await Promise.all([getCurrentValidators(), getCChainAddressMap()]);
  const now = Math.floor(Date.now() / 1000);
  const prevSnapshot = loadSnapshot();
  const nextSnapshot: UptimeSnapshot = {};

  for (const nodeId of FLARE_NODE_IDS) {
    const v = validators.find(val => matchesNodeId(nodeId, val.nodeID));
    if (!v) {
      console.warn(`Uptime check: node ${nodeId} not found in current validators`);
      continue;
    }

    const uptime = parseFloat(v.uptime);
    const totalSeconds = now - parseInt(v.startTime, 10);
    // connectedSeconds = fraction of total staking time the validator was online
    const connectedSeconds = totalSeconds * (uptime / 100);

    nextSnapshot[v.nodeID] = { uptime, totalSeconds, capturedAt: now };

    const prev = prevSnapshot[v.nodeID];
    let missedBlocksLast5Min = 0;

    if (prev) {
      const windowSeconds = now - prev.capturedAt;
      const prevConnected  = prev.totalSeconds * (prev.uptime / 100);
      const missedSeconds  = windowSeconds - (connectedSeconds - prevConnected);
      missedBlocksLast5Min = Math.max(0, Math.round(missedSeconds / BLOCK_TIME_SECONDS));
    }

    if (missedBlocksLast5Min > 0 || !v.connected) {
      const info: UptimeAlertInfo = {
        nodeId: v.nodeID,
        cChainAddress: cChainMap.get(v.nodeID) ?? '',
        uptime,
        connected: v.connected,
        missedBlocksLast5Min,
      };
      await sendUptimeAlert(info);
      console.log(`Uptime alert sent for ${v.nodeID}: uptime=${uptime}% missed=${missedBlocksLast5Min ?? '?'}`);
    } else {
      console.log(`${v.nodeID}: uptime ${uptime}% — OK`);
    }
  }

  saveSnapshot(nextSnapshot);
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export const handler: Handler = async () => {
  await checkAllUptimes();
};

// ─── Local dev ────────────────────────────────────────────────────────────────

if (require.main === module) {
  Promise.resolve(handler({} as never, {} as never, () => {})).catch(console.error);
}
