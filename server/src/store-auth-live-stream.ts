import { randomUUID } from 'node:crypto';

interface LiveStreamTokenRecord {
  sessionId: string;
  userId: number;
  expiresAt: number;
}

interface LiveStreamSubscriber {
  sendSnapshot: (payload: unknown) => void;
  close?: () => void;
}

export interface StoreAuthLiveStreamTokenPayload {
  streamToken: string;
  expiresAt: string;
}

export class StoreAuthLiveStreamManager {
  private readonly tokenTtlMs: number;

  private readonly tokens = new Map<string, LiveStreamTokenRecord>();

  private readonly subscribers = new Map<string, Map<string, LiveStreamSubscriber>>();

  constructor(input?: { tokenTtlMs?: number }) {
    this.tokenTtlMs = input?.tokenTtlMs ?? 30 * 60 * 1000;
  }

  private pruneExpiredTokens() {
    const now = Date.now();
    for (const [token, record] of this.tokens.entries()) {
      if (record.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }

  issueToken(input: { sessionId: string; userId: number }): StoreAuthLiveStreamTokenPayload {
    this.pruneExpiredTokens();
    const expiresAt = Date.now() + this.tokenTtlMs;
    const streamToken = randomUUID();
    this.tokens.set(streamToken, {
      sessionId: input.sessionId,
      userId: input.userId,
      expiresAt,
    });

    return {
      streamToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  validateToken(input: { sessionId: string; userId: number; streamToken: string }) {
    const record = this.resolveToken(input.sessionId, input.streamToken);
    if (!record) {
      return false;
    }

    return record.userId === input.userId;
  }

  resolveToken(sessionId: string, streamToken: string) {
    this.pruneExpiredTokens();
    const record = this.tokens.get(streamToken);
    if (!record) {
      return null;
    }

    return record.sessionId === sessionId ? record : null;
  }

  subscribe(sessionId: string, subscriber: LiveStreamSubscriber) {
    const subscriberId = randomUUID();
    const current = this.subscribers.get(sessionId) ?? new Map<string, LiveStreamSubscriber>();
    current.set(subscriberId, subscriber);
    this.subscribers.set(sessionId, current);

    return () => {
      const existing = this.subscribers.get(sessionId);
      if (!existing) {
        return;
      }

      existing.delete(subscriberId);
      if (existing.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  publishSnapshot(sessionId: string, payload: unknown) {
    const current = this.subscribers.get(sessionId);
    if (!current || current.size === 0) {
      return;
    }

    for (const [subscriberId, subscriber] of current.entries()) {
      try {
        subscriber.sendSnapshot(payload);
      } catch {
        subscriber.close?.();
        current.delete(subscriberId);
      }
    }

    if (current.size === 0) {
      this.subscribers.delete(sessionId);
    }
  }

  closeAll() {
    for (const subscribers of this.subscribers.values()) {
      for (const subscriber of subscribers.values()) {
        subscriber.close?.();
      }
    }
    this.subscribers.clear();
    this.tokens.clear();
  }
}
