import { describe, expect, it } from 'vitest';
import { bypassesProxy, proxyFor } from '../src/network.ts';
import { connectUrl } from '../src/tunnel.ts';

describe('proxyFor', () => {
  const target = new URL('wss://via443.com/connect');

  it('uses HTTPS_PROXY or https_proxy for wss targets', () => {
    expect(proxyFor(target, { HTTPS_PROXY: 'http://127.0.0.1:3128' })?.href).toBe('http://127.0.0.1:3128/');
    expect(proxyFor(target, { https_proxy: 'proxy.corp:8080' })?.host).toBe('proxy.corp:8080');
    expect(proxyFor(target, {})).toBeUndefined();
  });

  it('honors NO_PROXY', () => {
    expect(proxyFor(target, { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'via443.com' })).toBeUndefined();
    expect(proxyFor(target, { HTTPS_PROXY: 'http://p:1', no_proxy: 'other.com' })).toBeDefined();
  });
});

describe('bypassesProxy', () => {
  const url = (s: string) => new URL(s);
  it('matches hosts, domain suffixes, wildcards and ports', () => {
    expect(bypassesProxy(url('wss://via443.com/'), '*')).toBe(true);
    expect(bypassesProxy(url('wss://a.via443.com/'), 'via443.com')).toBe(true);
    expect(bypassesProxy(url('wss://a.via443.com/'), '.via443.com')).toBe(true);
    expect(bypassesProxy(url('wss://a.via443.com/'), '*.via443.com')).toBe(true);
    expect(bypassesProxy(url('wss://notvia443.com/'), 'via443.com')).toBe(false);
    expect(bypassesProxy(url('wss://via443.com/'), 'via443.com:443')).toBe(true);
    expect(bypassesProxy(url('wss://via443.com/'), 'via443.com:8443')).toBe(false);
    expect(bypassesProxy(url('ws://localhost:8080/'), 'localhost')).toBe(true);
  });

  it('matches IPv4 CIDRs and IPv6 literals', () => {
    expect(bypassesProxy(url('ws://127.0.0.1:8080/'), '127.0.0.0/8')).toBe(true);
    expect(bypassesProxy(url('ws://10.1.2.3/'), '10.0.0.0/8, 192.168.0.0/16')).toBe(true);
    expect(bypassesProxy(url('ws://11.1.2.3/'), '10.0.0.0/8')).toBe(false);
    expect(bypassesProxy(url('ws://[::1]:8080/'), '::1')).toBe(true);
  });
});

describe('connectUrl', () => {
  it('turns a domain or URL into the /connect WebSocket URL', () => {
    expect(connectUrl('via443.com').href).toBe('wss://via443.com/connect');
    expect(connectUrl('https://relay.example.com/').href).toBe('wss://relay.example.com/connect');
    expect(connectUrl('http://localhost:8080').href).toBe('ws://localhost:8080/connect');
    expect(() => connectUrl('ftp://x')).toThrow(/unsupported/);
  });
});
