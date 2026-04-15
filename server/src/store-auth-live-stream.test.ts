import { describe, expect, it, vi } from 'vitest';

import { StoreAuthLiveStreamManager } from './store-auth-live-stream.js';

describe('授权会话实时推送管理器', () => {
  it('只允许同一用户订阅自己的会话流', () => {
    const manager = new StoreAuthLiveStreamManager({ tokenTtlMs: 60_000 });
    const payload = manager.issueToken({
      sessionId: '4c6937ba-bad8-4f71-9260-b4d534b74d0c',
      userId: 7,
    });

    expect(
      manager.validateToken({
        sessionId: '4c6937ba-bad8-4f71-9260-b4d534b74d0c',
        userId: 7,
        streamToken: payload.streamToken,
      }),
    ).toBe(true);
    expect(
      manager.validateToken({
        sessionId: '4c6937ba-bad8-4f71-9260-b4d534b74d0c',
        userId: 8,
        streamToken: payload.streamToken,
      }),
    ).toBe(false);
    expect(
      manager.validateToken({
        sessionId: 'd9c2ef5e-2bab-4ac1-8d41-4fbd4209aef5',
        userId: 7,
        streamToken: payload.streamToken,
      }),
    ).toBe(false);
  });

  it('只向匹配会话推送快照', () => {
    const manager = new StoreAuthLiveStreamManager();
    const sendSnapshot = vi.fn();
    const close = vi.fn();

    const unsubscribe = manager.subscribe('session-a', {
      sendSnapshot,
      close,
    });

    manager.publishSnapshot('session-b', { step: 'ignored' });
    expect(sendSnapshot).not.toHaveBeenCalled();

    manager.publishSnapshot('session-a', { step: 'live' });
    expect(sendSnapshot).toHaveBeenCalledTimes(1);
    expect(sendSnapshot).toHaveBeenCalledWith({ step: 'live' });

    unsubscribe();
    manager.publishSnapshot('session-a', { step: 'after-unsubscribe' });
    expect(sendSnapshot).toHaveBeenCalledTimes(1);

    manager.closeAll();
    expect(close).not.toHaveBeenCalled();
  });
});
