import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNodeLine, parseNodeList, classifyNodeLine, decodeSubscription } from '../src/lib/node-parser.js';

// ---------- 支持的协议：HTTP / HTTPS ----------

test('解析 http 代理链接', () => {
  const n = parseNodeLine('http://1.2.3.4:8080');
  assert.equal(n.protocol, 'http');
  assert.equal(n.host, '1.2.3.4');
  assert.equal(n.port, 8080);
  assert.equal(n.username, '');
});

test('解析 https 代理链接', () => {
  const n = parseNodeLine('https://proxy.example.com:8443#加密代理');
  assert.equal(n.protocol, 'https');
  assert.equal(n.port, 8443);
  assert.equal(n.name, '加密代理');
});

test('解析带认证的 http 链接', () => {
  const n = parseNodeLine('http://user:p%40ss@proxy.example.com:3128#香港01');
  assert.equal(n.protocol, 'http');
  assert.equal(n.host, 'proxy.example.com');
  assert.equal(n.port, 3128);
  assert.equal(n.username, 'user');
  assert.equal(n.password, 'p@ss', 'percent-encoding 必须解码');
  assert.equal(n.name, '香港01', 'fragment 作为节点名');
});

test('无协议的 host:port 默认按 http 处理', () => {
  const n = parseNodeLine('10.0.0.5:3128');
  assert.equal(n.protocol, 'http');
  assert.equal(n.host, '10.0.0.5');
  assert.equal(n.port, 3128);
});

test('无协议的 host:port:user:pass（常见订阅格式）', () => {
  const n = parseNodeLine('10.0.0.5:3128:alice:secret');
  assert.equal(n.username, 'alice');
  assert.equal(n.password, 'secret');
  assert.equal(n.port, 3128);
});

test('IPv6 字面量地址', () => {
  const n = parseNodeLine('http://[2001:db8::1]:8080');
  assert.equal(n.host, '2001:db8::1');
  assert.equal(n.port, 8080);
});

test('缺省端口按协议补齐', () => {
  assert.equal(parseNodeLine('http://a.com').port, 80);
  assert.equal(parseNodeLine('https://a.com').port, 443);
});

test('raw 字段保留原始链接', () => {
  const line = 'http://1.2.3.4:8080#节点';
  assert.equal(parseNodeLine(line).raw, line);
});

// ---------- 不支持的协议：识别但不接纳 ----------

test('SOCKS5 被识别为不支持，且给出中文提示', () => {
  const r = classifyNodeLine('socks5://user:pass@1.2.3.4:1080#节点');
  assert.equal(r.kind, 'unsupported');
  assert.equal(r.protocol, 'socks5');
  assert.equal(r.label, 'SOCKS5');
  assert.match(r.reason, /本程序不支持该代理类型，仅支持 HTTP\/HTTPS 代理/);
});

test('socks / socks5h / socks4 全部不支持', () => {
  for (const line of ['socks://a:1', 'socks5h://a:1', 'socks4://a:1']) {
    assert.equal(classifyNodeLine(line).kind, 'unsupported', line);
    assert.equal(parseNodeLine(line), null, line);
  }
});

test('VLESS / Hysteria2 / Trojan / SS 全部不支持', () => {
  const cases = [
    ['vless://11111111-2222-3333-4444-555555555555@v.example.com:443?security=tls#VL', 'VLESS'],
    ['hysteria2://pw@h.example.com:8443?sni=h.example.com#HY2', 'Hysteria2'],
    ['hy2://pw@h.example.com:443', 'Hysteria2'],
    ['trojan://pw@t.example.com:443#TJ', 'Trojan'],
    ['ss://aes-256-gcm:pw@s.example.com:8388#SS', 'Shadowsocks'],
    ['vmess://eyJhZGQiOiJhIn0=', 'VMess'],
  ];
  for (const [line, label] of cases) {
    const r = classifyNodeLine(line);
    assert.equal(r.kind, 'unsupported', `${line} 应判为不支持`);
    assert.equal(r.label, label);
    assert.match(r.reason, /仅支持 HTTP\/HTTPS 代理/);
    assert.equal(parseNodeLine(line), null, `${line} 不得产出可用节点`);
  }
});

test('带账号密码的非 HTTP/HTTPS 节点同样不支持', () => {
  const r = classifyNodeLine('socks5://alice:secret@1.2.3.4:1080');
  assert.equal(r.kind, 'unsupported');
  assert.match(r.reason, /仅支持 HTTP\/HTTPS 代理/);
});

// ---------- 非法输入 ----------

test('非法输入返回 null', () => {
  assert.equal(parseNodeLine(''), null);
  assert.equal(parseNodeLine('   '), null);
  assert.equal(parseNodeLine('# 这是注释'), null);
  assert.equal(parseNodeLine('随便一句话'), null);
  assert.equal(parseNodeLine('http://a.com:99999'), null, '端口越界');
  assert.equal(parseNodeLine('ftp://a.com:21'), null, '无法识别的协议');
});

test('无法识别的协议归为 invalid 而非 unsupported', () => {
  const r = classifyNodeLine('ftp://a.com:21');
  assert.equal(r.kind, 'invalid');
  assert.match(r.reason, /无法识别的协议/);
});

test('注释行被单独归类', () => {
  assert.equal(classifyNodeLine('# 注释').kind, 'comment');
  assert.equal(classifyNodeLine('// 注释').kind, 'comment');
});

// ---------- 批量解析 ----------

test('parseNodeList 把节点 / 不支持 / 错误分成三类', () => {
  const { nodes, unsupported, errors } = parseNodeList(`
    http://1.1.1.1:8080
    # 注释行
    socks5://2.2.2.2:1080
    vless://uuid@v.com:443
    这行是垃圾
    https://3.3.3.3:8443
  `);
  assert.equal(nodes.length, 2, '只接纳 http 与 https');
  assert.deepEqual(nodes.map((n) => n.protocol), ['http', 'https']);
  assert.equal(unsupported.length, 2);
  assert.deepEqual(unsupported.map((u) => u.label), ['SOCKS5', 'VLESS']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /无法识别/);
});

test('parseNodeList 支持逗号与分号分隔', () => {
  const { nodes } = parseNodeList('http://1.1.1.1:80, https://2.2.2.2:443; http://3.3.3.3:80');
  assert.equal(nodes.length, 3);
});

test('parseNodeList 全是不支持的协议时 nodes 为空但 unsupported 完整', () => {
  const { nodes, unsupported } = parseNodeList('socks5://a:1\nvless://b@c:443\nhysteria2://d@e:443');
  assert.equal(nodes.length, 0);
  assert.equal(unsupported.length, 3);
});

// ---------- 订阅解码 ----------

test('decodeSubscription 解码 base64 订阅内容', () => {
  const raw = 'http://1.1.1.1:8080\nhttps://2.2.2.2:443';
  assert.equal(decodeSubscription(Buffer.from(raw).toString('base64')), raw);
});

test('decodeSubscription 对已是明文的输入原样返回', () => {
  const raw = 'http://1.1.1.1:8080';
  assert.equal(decodeSubscription(raw), raw);
});

test('decodeSubscription 兼容 URL-safe base64 且容忍缺失 padding', () => {
  const raw = 'http://1.1.1.1:8080/?a=1&b=2';
  const b64 = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeSubscription(b64), raw);
});
