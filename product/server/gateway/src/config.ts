/**
 * config.ts — 配置加载（config.json + 环境变量覆盖）
 */

import { existsSync, readFileSync } from 'node:fs';

export interface GatewayConfig {
  access?: { adminKeyFile: string; vaultKeyFile: string };
  webPush?: { subject: string; publicKeyFile: string; privateKeyFile: string } | null;
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
  /**
   * 内置隧道（自研，替代 frps）：PC 经 wss://<本服务>/tunnel 出站连入，
   * 网关把 services 里的端口绑在 **127.0.0.1** 上，流量透明转发到 PC。
   * enabled=false 时不绑定端口（把 3080/3081 让给 frps），/tunnel 升级后回 tunnel-disabled。
   */
  tunnel: {
    enabled: boolean;
    /** 服务名 → 网关侧绑定端口（须与 adapter 的 baseUrl / dir 服务端口一致） */
    services: Record<string, number>;
    maxStreams: number;
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
  tunnel: {
    enabled: false,
    services: { dsh: 3080, dir: 3081, codex: 3082 },
    maxStreams: 128,
  },
  adapters: {
    mock: { enabled: true },
    dsh: { enabled: false, cfg: { baseUrl: 'http://127.0.0.1:3080' } },
    // 需先升级 PC 端（本机 3082 CodexBridge）后再在生产 config.json 显式开启。
    codex: { enabled: false, cfg: { baseUrl: 'http://127.0.0.1:3082' } },
  },
};

export function loadConfig(path = process.env.GATEWAY_CONFIG ?? './config.json'): GatewayConfig {
  let cfg = DEFAULTS;
  if (existsSync(path)) {
    let raw: Partial<GatewayConfig>;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayConfig>;
    } catch (e) {
      throw new Error(`config parse failed: ${path}: ${(e as Error).message}`);
    }
    cfg = { ...DEFAULTS, ...raw };
    // 浅合并会吞掉嵌套子键：只写 {"tunnel":{"enabled":true}} 会让 services 整个丢失 —— 显式二次合并
    cfg.tunnel = {
      ...DEFAULTS.tunnel,
      ...(raw.tunnel ?? {}),
      services: { ...DEFAULTS.tunnel.services, ...(raw.tunnel?.services ?? {}) },
    };
    // 旧生产 config.json 往往只写 mock/dsh；不能因为顶层浅合并而丢掉新加的
    // codex 默认禁用项，也不能丢掉某个 adapter 的 baseUrl 默认值。
    cfg.adapters = mergeAdapters(DEFAULTS.adapters, raw.adapters);
  }
  // 环境变量覆盖
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.GATEWAY_HOST) cfg.host = process.env.GATEWAY_HOST;
  if (process.env.DSH_AGENT_KEY) cfg.agentKey = process.env.DSH_AGENT_KEY;
  if (process.env.GATEWAY_TUNNEL === 'on') cfg.tunnel.enabled = true;
  if (process.env.GATEWAY_TUNNEL === 'off') cfg.tunnel.enabled = false;
  if (process.env.DSH_BASE_URL) {
    cfg.adapters.dsh = { enabled: true, cfg: { baseUrl: process.env.DSH_BASE_URL } };
  }
  return cfg;
}

function mergeAdapters(
  defaults: GatewayConfig['adapters'],
  raw: GatewayConfig['adapters'] | undefined,
): GatewayConfig['adapters'] {
  const ids = new Set([...Object.keys(defaults), ...Object.keys(raw ?? {})]);
  const merged: GatewayConfig['adapters'] = {};
  for (const id of ids) {
    const base = defaults[id] ?? {};
    const override = raw?.[id] ?? {};
    merged[id] = {
      ...base,
      ...override,
      cfg: { ...(base.cfg ?? {}), ...(override.cfg ?? {}) },
    };
  }
  return merged;
}
