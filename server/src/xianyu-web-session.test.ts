import { describe, expect, it } from 'vitest';

import {
  isXianyuWebSocketAuthCacheUsable,
  parseXianyuWebSocketConversationListFrame,
  shouldUseXianyuImBrowserConversationFallback,
} from './xianyu-web-session.js';

describe('xianyu web session browser fallback', () => {
  it('parses websocket conversation frames into usable IM sessions', () => {
    const encodedMessage = Buffer.from(
      JSON.stringify({
        text: {
          text: 'can do 199?',
        },
      }),
      'utf8',
    ).toString('base64');
    const payload = JSON.stringify({
      body: {
        userConvs: [
          {
            singleChatUserConversation: {
              visible: 1,
              modifyTime: 1773667180933,
              redPoint: 2,
              joinTime: 1772695415798,
              lastMessage: {
                message: {
                  messageId: 'msg-1001',
                  createAt: 1773667180890,
                  sender: {
                    uid: '99887766@goofish',
                  },
                  content: {
                    custom: {
                      summary: '',
                      data: encodedMessage,
                      type: 1,
                    },
                    contentType: 101,
                  },
                  extension: {
                    sessionType: '1',
                  },
                },
              },
              singleChatConversation: {
                bizType: '1',
                cid: '58825031980@goofish',
                pairFirst: '99887766@goofish',
                pairSecond: '2219728876568@goofish',
                extension: {
                  extUserId: '99887766',
                  ownerUserId: '2219728876568',
                  itemId: '1012603042378',
                  itemMainPic: 'https://example.com/item.png',
                },
              },
            },
          },
          {
            singleChatUserConversation: {
              visible: 0,
              singleChatConversation: {
                bizType: '3',
                cid: '49414168893@goofish',
                extension: {
                  ownerUserId: '2219728876568',
                },
              },
            },
          },
        ],
      },
    });

    const records = parseXianyuWebSocketConversationListFrame(payload);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      cid: '58825031980@goofish',
      sessionId: '58825031980',
      sessionType: 1,
      bizType: 1,
      sellerUserId: '2219728876568',
      buyerUserId: '99887766',
      itemId: '1012603042378',
      itemMainPic: 'https://example.com/item.png',
      summaryText: 'can do 199?',
      unreadCount: 2,
      lastMessageId: 'msg-1001',
      lastMessageSenderUserId: '99887766',
      lastMessageText: 'can do 199?',
      lastMessageRawContentType: 101,
    });
    expect(records[1]).toMatchObject({
      cid: '49414168893@goofish',
      sessionId: '49414168893',
      bizType: 3,
    });
  });

  it('detects when notification-only sync results should fall back to browser capture', () => {
    expect(
      shouldUseXianyuImBrowserConversationFallback([
        {
          sessionId: '49414168893',
          sessionType: 3,
          sellerUserId: null,
          sellerName: null,
          buyerUserId: null,
          buyerName: null,
          itemId: null,
          itemMainPic: null,
          summaryText: 'weekly report',
          summaryVersion: 1,
          summaryTimestamp: '2026-03-16 10:00:00',
          unreadCount: 1,
          sortIndex: 1,
        },
      ]),
    ).toBe(true);

    expect(
      shouldUseXianyuImBrowserConversationFallback([
        {
          sessionId: '58825031980',
          sessionType: 1,
          sellerUserId: '2219728876568',
          sellerName: 'seller',
          buyerUserId: '99887766',
          buyerName: 'buyer',
          itemId: '1012603042378',
          itemMainPic: null,
          summaryText: 'can do 199?',
          summaryVersion: null,
          summaryTimestamp: '2026-03-16 10:00:00',
          unreadCount: 1,
          sortIndex: 1,
        },
      ]),
    ).toBe(false);
  });

  it('only reuses websocket auth cache before it is close to expiring', () => {
    expect(
      isXianyuWebSocketAuthCacheUsable(
        {
          appKey: 'app-key',
          cacheHeader: 'app-key token ua wv',
          token: 'token-1',
          ua: 'ua-1',
          dt: 'j',
          wv: 'im:3,au:3,sy:6',
          sync: '0,0;0;0;',
          did: 'device-1',
          capturedAt: '2026-03-16 10:00:00',
          expiresAt: '2026-03-16 10:55:00',
        },
        new Date('2026-03-16T10:10:00'),
      ),
    ).toBe(true);

    expect(
      isXianyuWebSocketAuthCacheUsable(
        {
          appKey: 'app-key',
          cacheHeader: 'app-key token ua wv',
          token: 'token-1',
          ua: 'ua-1',
          dt: 'j',
          wv: 'im:3,au:3,sy:6',
          sync: '0,0;0;0;',
          did: 'device-1',
          capturedAt: '2026-03-16 10:00:00',
          expiresAt: '2026-03-16 10:11:00',
        },
        new Date('2026-03-16T10:10:00'),
      ),
    ).toBe(false);
  });
});
