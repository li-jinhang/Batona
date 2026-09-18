/**
 * adapter/registry.ts — 适配器注册表
 *
 * 网关按 id 查找适配器；适配器在 app.ts 启动时按配置实例化并注册。
 */

import type { AgentAdapter, AdapterConfig } from './contract.ts';

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private order: string[] = [];

  /** 注册一个已实例化的适配器 */
  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    this.order.push(adapter.id);
  }

  /** 按 id 取适配器 */
  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /** 必须存在的适配器（不存在则抛错） */
  require(id: string): AgentAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`adapter not found: ${id}`);
    return a;
  }

  list(): AgentAdapter[] {
    return this.order.map((id) => this.adapters.get(id)!);
  }

  /** 默认适配器（第一个注册的；会话未指定后端时使用） */
  default(): AgentAdapter | undefined {
    return this.order.length ? this.adapters.get(this.order[0]) : undefined;
  }

  /**
   * 按配置装配并连接适配器。
   * config: { adapters: { [id]: { enabled, cfg } } }，adapter 需自带工厂函数。
   */
  static async assemble(
    factories: Record<string, (cfg: AdapterConfig) => AgentAdapter>,
    config: Record<string, { enabled?: boolean; cfg?: AdapterConfig }>,
  ): Promise<AdapterRegistry> {
    const registry = new AdapterRegistry();
    for (const [id, entry] of Object.entries(config)) {
      if (entry.enabled === false) continue;
      const factory = factories[id];
      if (!factory) throw new Error(`no adapter factory for: ${id}`);
      const adapter = factory(entry.cfg ?? {});
      const connected = await adapter.connect(entry.cfg ?? {});
      if (!connected) throw new Error(`adapter failed to connect: ${id}`);
      registry.register(adapter);
    }
    return registry;
  }
}
