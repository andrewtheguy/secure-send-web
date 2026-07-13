import { describe, expect, it } from 'vitest';
import { getIceServers, getWebRTCConfig } from './webrtc-config';

describe('WebRTC configuration', () => {
  it('configures STUN discovery without TURN relay fallback', () => {
    const servers = getIceServers();

    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      expect(urls.every((url) => url.startsWith('stun:'))).toBe(true);
    }

    expect(getWebRTCConfig().iceServers).toEqual(servers);
  });
});
