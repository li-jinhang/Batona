/**
 * config.ts — 配置加载（config.json + 环境变量覆盖）
 */

import { existsSync, readFileSync } from 'node:fs';

export interface GatewayConfig {
  host: string;
  port: number;
  dataDir: string;
  webDir: string;
  /**
   * PC 软件上报 DSH launch token 的共享密钥（`POST /api/dsh/launch-token` 的 x-dsh-agent-key）。
   * 由 install.sh 用 frp token 填充；未配置时该通道关闭。
   * 背景：DSH 0.1.2+ 每个进程随机生成 launch token 且不落盘，网关只能由 PC 端在运行期注入。
   */
  agentKey: string;
  auth: {
    initialUser?: { username: string; password: string };
  };
  adapters: Record<string, { enabled?: boolean; cfg?: Record<string, unknown> }>;
}

const DEFAULTS: GatewayConfig = {
  host: '127.0.0.1',
  port: 3090,
  dataDir: './data',
  webDir: './web',
  agentKey: '',
  auth: {},
  adapters: {
    mock: { enabled: true },
    dsh: { enabled: false, cfg: { baseUrl: 'http://127.0.0.1:3080' } },
  },
};

export function loadConfig(path = process.env.GATEWAY_CONFIG ?? './config.json'): GatewayConfig {
  let cfg = DEFAULTS;
  if (existsSync(path)) {
    try {
      cfg = { ...DEFAULTS, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayConfig>) };
    } catch (e) {
      throw new Error(`config parse failed: ${path}: ${(e as Error).message}`);
    }
  }
  // 环境变量覆盖
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.GATEWAY_HOST) cfg.host = process.env.GATEWAY_HOST;
  if (process.env.DSH_AGENT_KEY) cfg.agentKey = process.env.DSH_AGENT_KEY;
  if (process.env.DSH_BASE_URL) {
    cfg.adapters.dsh = { enabled: true, cfg: { baseUrl: process.env.DSH_BASE_URL } };
  }
  return cfg;
}
