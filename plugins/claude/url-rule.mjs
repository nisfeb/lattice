// The agent key goes in every request, so the ship URL must be https, or
// plain http only to a loopback or LAN address. Shared by server.mjs and
// hooks/lattice-hook.mjs. The Hermes plugin has the same rule in
// plugins/hermes/__init__.py (_url_problem): keep the two in step.

// IPv4 ranges as [first octet, second octet low, second octet high]
const V4 = [[127, 0, 255], [10, 0, 255], [172, 16, 31], [192, 168, 168], [100, 64, 127]];

function privateHost(host) {
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return V4.some(([a, lo, hi]) => +v4[1] === a && +v4[2] >= lo && +v4[2] <= hi);
  if (host.includes(':')) {
    // new URL() has already compressed it, so ::1 is spelled one way.
    // fc00::/7 is any first group from fc00 to fdff.
    if (host === '::1') return true;
    const first = host.split(':')[0];
    return first !== '' && (parseInt(first, 16) & 0xfe00) === 0xfc00;
  }
  return host === 'localhost' || ['.localhost', '.local', '.ts.net'].some((s) => host.endsWith(s));
}

// Empty when the ship URL is allowed, else why it is refused.
export function urlProblem(raw) {
  let url;
  try { url = new URL(raw); } catch { return `lattice: the ship URL "${raw}" is not a valid URL`; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol === 'https:' && host) return '';
  if (url.protocol === 'http:' && host && privateHost(host)) return '';
  return `lattice: the ship URL "${raw}" would send the agent key unencrypted. Use https, or a loopback or LAN address.`;
}
