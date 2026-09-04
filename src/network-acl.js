import net from 'node:net';

// Keep this limit deliberately generous enough for a normal home/LAN policy,
// while preventing an accidentally unbounded environment variable or config
// value from turning every connection into a large linear scan.
export const MAX_ALLOWED_CIDRS = 128;

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAPPED_PREFIX = 0xffffn << 32n;
const IPV4_MAPPED_MASK = ((1n << 128n) - 1n) ^ ((1n << 32n) - 1n);

function invalid(value, detail = '') {
  const suffix = detail ? ` (${detail})` : '';
  throw new TypeError(`invalid LAN proxy allowed CIDR${suffix}: ${String(value)}`);
}

function maskFor(bits, prefix) {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
}

function parseIPv4(value) {
  // net.isIP intentionally accepts only canonical dotted decimal IPv4 forms;
  // retain an explicit parser so values such as signs, octal-looking groups,
  // and embedded whitespace cannot be normalized ambiguously.
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  let result = 0n;
  for (const part of parts) {
    const number = Number(part);
    if (number > 255) return null;
    result = (result << 8n) | BigInt(number);
  }
  return { family: 4, value: result, bits: IPV4_BITS, mapped: false };
}

function parseIPv6(value) {
  // RFC 4291 permits one embedded dotted-decimal IPv4 tail. Convert it to two
  // hextets before expanding ::. Zone identifiers are intentionally rejected:
  // an ACL must describe an address independent of a host-specific interface.
  if (!value || value.includes('%') || value.includes('[') || value.includes(']')) return null;
  let text = value;
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    if (colon < 0) return null;
    const ipv4 = parseIPv4(text.slice(colon + 1));
    if (!ipv4) return null;
    const high = Number((ipv4.value >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4.value & 0xffffn).toString(16);
    text = `${text.slice(0, colon)}:${high}:${low}`;
  }

  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1 && text.indexOf('::', doubleColon + 2) !== -1) return null;
  let groups;
  if (doubleColon === -1) {
    groups = text.split(':');
    if (groups.length !== 8) return null;
  } else {
    const left = text.slice(0, doubleColon) ? text.slice(0, doubleColon).split(':') : [];
    const rightText = text.slice(doubleColon + 2);
    const right = rightText ? rightText.split(':') : [];
    if (left.some((group) => group === '') || right.some((group) => group === '')) return null;
    if (left.length + right.length >= 8) return null; // :: must stand for >= 1 group
    groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  }
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(parseInt(group, 16));
  return {
    family: 6,
    value: result,
    bits: IPV6_BITS,
    mapped: (result & IPV4_MAPPED_MASK) === IPV4_MAPPED_PREFIX,
  };
}

/** Parse a bare IP address, returning an internal bigint representation. */
function parseAddress(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/\s/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (net.isIP(value) === 4) return parseIPv4(value);
  if (net.isIP(value) === 6) return parseIPv6(value);
  return null;
}

function formatIPv4(value) {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

// RFC 5952-style lowercase compressed IPv6 rendering. A zero run is only
// compressed when it contains at least two groups; ties select the leftmost.
function formatIPv6(value) {
  const groups = [];
  for (let index = 7; index >= 0; index -= 1) {
    groups[index] = Number(value & 0xffffn);
    value >>= 16n;
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < groups.length && groups[index] === 0) index += 1;
    const length = index - start;
    if (length > bestLength && length >= 2) {
      bestStart = start;
      bestLength = length;
    }
  }
  if (bestStart === 0 && bestLength === groups.length) return '::';
  const rendered = [];
  for (let index = 0; index < groups.length; index += 1) {
    if (index === bestStart) {
      rendered.push('');
      index += bestLength - 1;
      if (index === groups.length - 1) rendered.push('');
    } else {
      rendered.push(groups[index].toString(16));
    }
  }
  let result = rendered.join(':');
  if (result.startsWith(':') && !result.startsWith('::')) result = `:${result}`;
  if (result.endsWith(':') && !result.endsWith('::')) result = `${result}:`;
  return result;
}

function formatAddress(value, family) {
  return family === 4 ? formatIPv4(value) : formatIPv6(value);
}

function parseRule(entry) {
  if (typeof entry !== 'string') invalid(entry, 'entry must be a string');
  const value = entry.trim();
  if (!value || /\s/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) invalid(entry);
  const slash = value.indexOf('/');
  if (slash !== -1 && value.indexOf('/', slash + 1) !== -1) invalid(entry);
  const addressText = slash === -1 ? value : value.slice(0, slash);
  const address = parseAddress(addressText);
  if (!address) invalid(entry, 'address must be a canonical IPv4 or IPv6 literal');
  let prefix = address.bits;
  if (slash !== -1) {
    const prefixText = value.slice(slash + 1);
    // Decimal-only prefixes avoid accepting signs, exponents, or fractional
    // values that Number() would otherwise silently coerce.
    if (!/^\d{1,3}$/.test(prefixText)) invalid(entry, 'prefix must be an integer');
    prefix = Number(prefixText);
    if (prefix < 0 || prefix > address.bits) invalid(entry, `prefix must be between 0 and ${address.bits}`);
  }
  const network = address.value & maskFor(address.bits, prefix);
  const canonicalAddress = formatAddress(network, address.family);
  const canonical = `${canonicalAddress}/${prefix}`;
  return {
    family: address.family,
    bits: address.bits,
    prefix,
    value: network,
    canonical,
    mapped: address.family === 6 && (network & IPV4_MAPPED_MASK) === IPV4_MAPPED_PREFIX,
  };
}

function tokenize(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.trim() === '') invalid(value, 'list must not be empty');
    const tokens = value.split(',').map((item) => item.trim());
    if (tokens.some((item) => item === '')) invalid(value, 'list contains an empty entry');
    return tokens;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) invalid(value, 'list must not be empty');
    return value;
  }
  invalid(value, 'list must be a comma-separated string or an array');
}

/**
 * Parse and strictly normalize an allowed-CIDR setting.
 *
 * `undefined` means the ACL is disabled. Any explicit value must contain at
 * least one valid address/network. Bare addresses become /32 or /128 entries;
 * host bits in a network are masked in the returned canonical representation.
 */
export function parseAllowedCidrs(value, options = {}) {
  const tokens = tokenize(value);
  if (tokens === undefined) return undefined;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : MAX_ALLOWED_CIDRS;
  if (tokens.length > maxEntries) invalid(value, `at most ${maxEntries} entries are allowed`);
  const seen = new Set();
  const normalized = [];
  for (const token of tokens) {
    // A comma is only a separator for string input. Reject it in an array item
    // so callers cannot accidentally hide malformed configuration structure.
    if (Array.isArray(value) && typeof token === 'string' && token.includes(',')) invalid(token);
    const rule = parseRule(token);
    if (!seen.has(rule.canonical)) {
      seen.add(rule.canonical);
      normalized.push(rule.canonical);
    }
  }
  if (normalized.length === 0) invalid(value, 'list must not be empty');
  return normalized;
}

function parseNormalizedRules(value, options) {
  const cidrs = parseAllowedCidrs(value, options);
  if (cidrs === undefined) return undefined;
  return cidrs.map(parseRule);
}

function inSubnet(address, rule) {
  if (address.family !== rule.family) return false;
  return (address.value & maskFor(rule.bits, rule.prefix)) === rule.value;
}

function mappedIPv4Part(address) {
  if (address.family !== 6 || !address.mapped) return null;
  return {
    family: 4,
    bits: IPV4_BITS,
    value: address.value & ((1n << 32n) - 1n),
    mapped: false,
  };
}

function mappedRuleAsIPv4(rule) {
  // A mapped IPv6 network only has an unambiguous IPv4 equivalent when its
  // prefix reaches the mapped /96 boundary. E.g. ::ffff:192.0.2.0/112 maps
  // to 192.0.2.0/16; a broader /80 is kept IPv6-only.
  if (rule.family !== 6 || !rule.mapped || rule.prefix < 96) return null;
  const prefix = rule.prefix - 96;
  return {
    family: 4,
    bits: IPV4_BITS,
    prefix,
    value: rule.value & maskFor(IPV4_BITS, prefix),
    mapped: false,
  };
}

/**
 * Compile an allowed-CIDR value into a small immutable matcher. `undefined`
 * returns `null`, which denotes the backwards-compatible disabled ACL mode.
 */
export function compileAllowedCidrs(value, options = {}) {
  if (value && typeof value === 'object' && typeof value.allows === 'function' && value.enabled !== false) return value;
  const rules = parseNormalizedRules(value, options);
  if (rules === undefined) return null;
  for (const rule of rules) Object.freeze(rule);
  const mappedRules = rules.map(mappedRuleAsIPv4).filter(Boolean);
  const allows = (address) => {
    const parsed = typeof address === 'string' ? parseAddress(address) : address;
    if (!parsed) return false;
    const mapped = mappedIPv4Part(parsed);
    for (const rule of rules) {
      if (parsed.family === 6 && parsed.mapped) {
        // Treat a mapped peer as IPv4 for ordinary IPv4 rules, but do not let
        // a broad native-IPv6 rule such as ::/0 silently admit IPv4. A mapped
        // IPv6 rule (for example ::ffff:0:0/96) must be explicit.
        if (rule.family === 6 && rule.mapped && inSubnet(parsed, rule)) return true;
        if (rule.family === 4 && mapped && inSubnet(mapped, rule)) return true;
        continue;
      }
      if (inSubnet(parsed, rule)) return true;
    }
    // Treat explicitly configured mapped IPv6 networks as their IPv4
    // equivalent too, so the policy is stable across socket address forms.
    if (parsed.family === 4 && mappedRules.some((rule) => inSubnet(parsed, rule))) return true;
    return false;
  };
  const matcher = {
    enabled: true,
    cidrs: Object.freeze(rules.map((rule) => rule.canonical)),
    rules: Object.freeze(rules),
    allows,
    check: allows,
    test: allows,
  };
  return Object.freeze(matcher);
}

// Names used by configuration and LAN proxy callers. Keep both explicit names
// available so integrations can migrate without duplicating parsing logic.
export const parseLanProxyAllowedCidrs = parseAllowedCidrs;
export const compileLanProxyAcl = compileAllowedCidrs;

/** Check an address against a matcher or raw allowed-CIDR setting. */
export function isAddressAllowed(address, matcher) {
  // Also accept the natural `(matcher, address)` order for small embedders;
  // this does not alter the documented `(address, matcher)` form.
  if (address && typeof address === 'object' && typeof address.allows === 'function') {
    return address.allows(matcher);
  }
  if (matcher === undefined) return true;
  const compiled = matcher && typeof matcher.allows === 'function' ? matcher : compileAllowedCidrs(matcher);
  return compiled ? compiled.allows(address) : true;
}

function isLoopback(parsed) {
  if (!parsed) return false;
  if (parsed.family === 4) return (parsed.value >> 24n) === 127n;
  if (parsed.value === 1n) return true;
  const mapped = mappedIPv4Part(parsed);
  return Boolean(mapped && (mapped.value >> 24n) === 127n);
}

/**
 * Return whether an address is a local source for the specified listener.
 * Loopback and the listener's own address (including mapped-v4 spelling) are
 * accepted for the in-process health probe exception.
 */
export function isLocalAddress(address, listenerAddress) {
  const parsed = typeof address === 'string' ? parseAddress(address) : address;
  if (!parsed) return false;
  if (isLoopback(parsed)) return true;
  const listener = typeof listenerAddress === 'string' ? parseAddress(listenerAddress) : listenerAddress;
  if (!listener) return false;
  if (parsed.family === listener.family && parsed.value === listener.value) return true;
  const parsedMapped = mappedIPv4Part(parsed);
  const listenerMapped = mappedIPv4Part(listener);
  if (parsedMapped && listener.family === 4) return parsedMapped.value === listener.value;
  if (listenerMapped && parsed.family === 4) return listenerMapped.value === parsed.value;
  return false;
}

export default {
  MAX_ALLOWED_CIDRS,
  parseAllowedCidrs,
  compileAllowedCidrs,
  parseLanProxyAllowedCidrs,
  compileLanProxyAcl,
  isAddressAllowed,
  isLocalAddress,
};
