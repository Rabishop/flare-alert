import type { ValidatorRewardInfo } from './flare';

export interface UptimeAlertInfo {
  nodeId: string;
  cChainAddress: string;
  uptime: number;
  connected: boolean;
  missedBlocksLast5Min: number;
}

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';

export async function sendRewardReport(info: ValidatorRewardInfo): Promise<void> {
  if (!SLACK_WEBHOOK_URL) throw new Error('SLACK_WEBHOOK_URL not configured');

  const stakeEndDate = info.stakeEnd.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const shortAddr = `${info.cChainAddress.slice(0, 10)}...${info.cChainAddress.slice(-6)}`;
  const addrLink = `<https://flare-systems-explorer.flare.network/providers/fsp/${info.cChainAddress}|${shortAddr}>`;
  const epochLink = `<https://flare-systems-explorer.flare.network/reward-epoch/${info.epochId}|${info.epochId}>`;
  const shortNodeId = `${info.nodeId.slice(0, 14)}...${info.nodeId.slice(-6)}`;

  const message = {
    attachments: [
      {
        color: '#00c04b',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `:fire: *FLARE VALIDATOR REWARD — ${info.totalRewardFLR ?? info.validatorRewardFLR} FLR*` },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*NODE ID*\n${shortNodeId}` },
              { type: 'mrkdwn', text: `*EPOCH*\n${epochLink}` },
              { type: 'mrkdwn', text: `*VALIDATOR REWARD*\n${info.validatorRewardFLR} FLR` },
              { type: 'mrkdwn', text: `*MIRROR REWARD*\n${info.mirrorRewardFLR ?? 'N/A'} FLR` },
              { type: 'mrkdwn', text: `*TOTAL REWARD*\n${info.totalRewardFLR ?? info.validatorRewardFLR} FLR` },
              { type: 'mrkdwn', text: `*TOTAL STAKE*\n${info.totalStakeFLR} FLR` },
              { type: 'mrkdwn', text: `*C-CHAIN ADDRESS*\n${addrLink}` },
              { type: 'mrkdwn', text: `*STAKE ENDS*\n${stakeEndDate}` },
            ],
          },
        ],
      },
    ],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!res.ok) throw new Error(`Slack webhook error: ${res.status} ${await res.text()}`);
}

export interface ProviderAlertInfo {
  identityAddress: string;
  rounds: number;
  ftsoSubmitted: number;
  ftsoMissed: number;
  fdcSubmitted: number;
  fdcMissed: number;
}

export async function sendProviderAlert(info: ProviderAlertInfo): Promise<void> {
  if (!SLACK_WEBHOOK_URL) throw new Error('SLACK_WEBHOOK_URL not configured');

  const shortAddr = `${info.identityAddress.slice(0, 10)}...${info.identityAddress.slice(-6)}`;
  const addrLink  = `<https://flare-systems-explorer.flare.network/providers/fsp/${info.identityAddress}|${shortAddr}>`;
  const parts: string[] = [];
  if (info.ftsoMissed > 0) parts.push(`FTSO ${info.ftsoMissed}`);
  if (info.fdcMissed  > 0) parts.push(`FDC ${info.fdcMissed}`);

  const message = {
    attachments: [{
      color: '#e01e5a',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `:warning: *FLARE PROVIDER — ${parts.join(' / ')} MISSED SUBMISSION(S)*` },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*IDENTITY ADDRESS*\n${addrLink}` },
            { type: 'mrkdwn', text: `*VOTING ROUNDS (5 MIN)*\n${info.rounds}` },
            { type: 'mrkdwn', text: `*FTSO SUBMITTED*\n${info.ftsoSubmitted} / ${info.rounds * 2}` },
            { type: 'mrkdwn', text: `*FTSO MISSED*\n${info.ftsoMissed}` },
            { type: 'mrkdwn', text: `*FDC SUBMITTED*\n${info.fdcSubmitted} / ${info.rounds}` },
            { type: 'mrkdwn', text: `*FDC MISSED*\n${info.fdcMissed}` },
          ],
        },
      ],
    }],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`Slack webhook error: ${res.status} ${await res.text()}`);
}

export async function sendUptimeAlert(info: UptimeAlertInfo): Promise<void> {
  if (!SLACK_WEBHOOK_URL) throw new Error('SLACK_WEBHOOK_URL not configured');

  const shortNodeId = `${info.nodeId.slice(0, 14)}...${info.nodeId.slice(-6)}`;
  const shortAddr = `${info.cChainAddress.slice(0, 10)}...${info.cChainAddress.slice(-6)}`;
  const addrLink = `<https://flare-systems-explorer.flare.network/providers/fsp/${info.cChainAddress}|${shortAddr}>`;
  const color = info.uptime < 99 ? '#e01e5a' : '#ecb22e';
  const title = info.connected
    ? `:warning: *FLARE VALIDATOR — ${info.missedBlocksLast5Min} MISSED BLOCK(S)*`
    : `:rotating_light: *FLARE VALIDATOR OFFLINE*`;

  const message = {
    attachments: [
      {
        color,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: title },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*NODE ID*\n${shortNodeId}` },
              { type: 'mrkdwn', text: `*C-CHAIN ADDRESS*\n${addrLink}` },
              { type: 'mrkdwn', text: `*UPTIME*\n${info.uptime.toFixed(4)}%` },
              { type: 'mrkdwn', text: `*MISSED BLOCKS (5 MIN)*\n${info.missedBlocksLast5Min}` },
            ],
          },
        ],
      },
    ],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!res.ok) throw new Error(`Slack webhook error: ${res.status} ${await res.text()}`);
}
