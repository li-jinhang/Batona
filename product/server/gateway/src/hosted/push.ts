import webpush from 'web-push';
import type { PushSubscription } from 'web-push';
import type { AgentEvent } from '../adapter/contract.ts';

export type PushCategory = 'approval' | 'question' | 'completed' | 'failed';
export interface StoredPushSubscription extends PushSubscription {}
export interface WebPushConfig { subject: string; publicKey: string; privateKey: string }
export type PushSender = (subscription: StoredPushSubscription, payload: string) => Promise<void>;

const CATEGORIES = new Set<PushCategory>(['approval', 'question', 'completed', 'failed']);

/** Reject non-Apple endpoints before persistence or network delivery; the PWA release targets iOS. */
export function parsePushSubscription(value: unknown): StoredPushSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-push-subscription');
  const item = value as { endpoint?: unknown; expirationTime?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof item.endpoint !== 'string' || item.endpoint.length > 2048) throw new Error('invalid-push-subscription');
  let endpoint: URL;
  try { endpoint = new URL(item.endpoint); } catch { throw new Error('invalid-push-subscription'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || (endpoint.port && endpoint.port !== '443') || !(endpoint.hostname === 'push.apple.com' || endpoint.hostname.endsWith('.push.apple.com'))) {
    throw new Error('invalid-push-subscription');
  }
  const p256dh = item.keys?.p256dh, auth = item.keys?.auth;
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{22,256}$/.test(p256dh) || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(auth)) {
    throw new Error('invalid-push-subscription');
  }
  if (item.expirationTime !== undefined && item.expirationTime !== null && (typeof item.expirationTime !== 'number' || !Number.isFinite(item.expirationTime))) {
    throw new Error('invalid-push-subscription');
  }
  return { endpoint: endpoint.toString(), expirationTime: item.expirationTime as number | null | undefined, keys: { p256dh, auth } };
}

export function attentionCategory(event: AgentEvent): PushCategory | null {
  switch (event.type) {
    case 'approval/requested': return 'approval';
    case 'question/requested': return 'question';
    case 'turn/end': return 'completed';
    case 'error': return 'failed';
    default: return null;
  }
}

/** Deliberately contains no account, session, tool, question, or conversation identifiers. */
export function notificationPayload(category: PushCategory): string {
  if (!CATEGORIES.has(category)) throw new Error('invalid-push-category');
  return JSON.stringify({ category });
}

export function createPushSender(config: WebPushConfig): PushSender {
  if (!/^https:\/\//.test(config.subject) && !/^mailto:[^\s@]+@[^\s@]+$/.test(config.subject)) throw new Error('invalid-vapid-subject');
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(config.publicKey) || !/^[A-Za-z0-9_-]{40,80}$/.test(config.privateKey)) throw new Error('invalid-vapid-key');
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return async (subscription, payload) => {
    const category = JSON.parse(payload) as { category: PushCategory };
    await webpush.sendNotification(subscription, payload, {
      TTL: 300,
      urgency: 'high',
      topic: `batona-${category.category}`,
    });
  };
}
