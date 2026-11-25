#!/usr/bin/env node
// restep-mock · fake Restep 1 API from a discovery document.
// Node 18 or later, no dependencies.
//   npx restep-mock <discovery.json | URL> [--port N] [--seed N] [--count 50] [--latency 0-300] [--fail-rate 0.05]
// Generates plausible, deterministic (by seed) data according to the type and name of each field, and
// behaves like a real draft 7 server (https://restep.wubytes.com/1/, "restep": "1.0-draft.7")
// in the core, query, writes, cache and relations profiles and the inherit extension: filters, collations, sorting,
// fields, pagination with signed cursors, counts, problem+json errors, reserved parameters that fail
// loudly, media types, id_from, singletons, in-memory writes with Idempotency-Key,
// ETag/If-Match/If-None-Match, language maps, inherited values (11.6) and sunset notices (5.5).
// Much of the code comes from the reference server (vendor/restep-server.mjs).
// Also subcollections (at any depth) and the actions extension, with simulated actions.
// What it does not implement (sync and the other extensions) it removes from the discovery document it serves and
// reports on standard error, so as not to announce anything it does not meet.
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const VERSION = '0.5.0';
const PROFILE = 'https://w3id.org/restep/1/'; // identifier: profile link and error types
const SPEC = 'https://restep.wubytes.com/1/'; // the page to read
// 1.1: the mock implements the text of draft 7 and declares it so, whatever the version of the source
// document: a server implements the text of the version it declares in restep (1.2).
const RESTEP = '1.0-draft.7';
const RESTEP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(draft|rc)\.(0|[1-9]\d*))?$/;
const SUPPORTED_PROFILES = ['core', 'query', 'writes', 'cache', 'relations'];
const SUPPORTED_EXTENSIONS = ['actions', 'inherit'];
// 5.5: where each kind of sunset notice goes.
const KINDS = {
  root: ['version', 'profile', 'extension', 'collection', 'singleton', 'reason'],
  collection: ['field', 'filter', 'operator', 'value', 'sort', 'relation', 'include', 'count', 'max_limit', 'action', 'method', 'item_method'],
  singleton: ['field', 'method'],
};
// Once the date has passed, the mock enforces the retirement of these kinds; it does not serve the
// expired notices of the others (and warns), because it cannot simulate them.
const RETIRES = ['filter', 'operator', 'sort', 'include', 'count', 'max_limit', 'method', 'item_method', 'action', 'collection', 'singleton'];
// 3: the grammar of names (actions, among others).
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// 6.1: the operators of this version; a server MUST NOT declare another.
const OPERATORS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'null', 'prefix', 'contains'];

// ── Command line ──────────────────────────────────────────────────────────────
const HELP = `restep-mock ${VERSION} · fake Restep 1 API from a discovery document

Usage: restep-mock <discovery.json | URL> [options]

  --port <n>             Port (default 8090; 0 picks a free one)
  --host <host>          Interface to listen on (default: all)
  --seed <n>             Seed for the data, the cursors and the failures (default 1)
  --count <n>            Items per collection (default 50)
  --count <col>=<n>      Items in one collection (repeatable)
  --latency <ms|a-b>     Delay on each response: fixed (120) or random within a range (0-300)
  --fail-rate <0..1>     Fraction of requests that get 503 unavailable with Retry-After
  --retry-after <s>      Seconds of Retry-After on those 503s (default 1)
  --dump                 Write the generated data as JSON to standard output and exit
  --quiet                No warnings on standard error
  -h, --help             This help

The seed makes the data reproducible: same seed and same discovery, same data.
Writes live in memory and are lost when it stops.`;

function parseArgs(argv) {
  const o = { source: null, port: 8090, host: undefined, seed: 1, count: 50, counts: {}, latency: [0, 0],
    failRate: 0, retryAfter: 1, dump: false, quiet: false };
  const value = (i, name) => {
    if (i >= argv.length) throw new Error(`Missing value for ${name}.`);
    return argv[i];
  };
  const int = (v, name, min = 0) => {
    if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be an integer greater than or equal to ${min}: ${v}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--port') o.port = int(value(++i, a), a);
    else if (a === '--host') o.host = value(++i, a);
    else if (a === '--seed') o.seed = int(value(++i, a), a);
    else if (a === '--count') {
      const v = value(++i, a), m = /^([^=]+)=(.*)$/.exec(v);
      if (m) o.counts[m[1]] = int(m[2], a); else o.count = int(v, a);
    } else if (a === '--latency') {
      const v = value(++i, a), m = /^(\d+)(?:-(\d+))?$/.exec(v);
      if (!m || (m[2] !== undefined && Number(m[2]) < Number(m[1]))) throw new Error(`--latency expects milliseconds (120) or a range (0-300): ${v}`);
      o.latency = [Number(m[1]), Number(m[2] ?? m[1])];
    } else if (a === '--fail-rate') {
      const v = value(++i, a), n = Number(v);
      if (!/^\d*\.?\d+$/.test(v) || n < 0 || n > 1) throw new Error(`--fail-rate expects a number between 0 and 1: ${v}`);
      o.failRate = n;
    } else if (a === '--retry-after') o.retryAfter = int(value(++i, a), a);
    else if (a === '--dump') o.dump = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}. See --help.`);
    else if (o.source) throw new Error(`Extra argument: ${a}. Only one discovery document is accepted.`);
    else o.source = a;
  }
  return o;
}

// ── The API's own texts in two languages (5.6), as in the reference ──────────
const LANGUAGES = ['en', 'es'];
const t = (en, es) => ({ en, es });
const text = (v, lang) => (typeof v === 'string' ? v : v[lang]);
const RANGE = /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i;
// 5.6: lookup (RFC 4647, 3.4) over the languages a response can be given in, case-insensitively; without a
// match, the default language.
function pickLanguage(header, available = LANGUAGES, fallback = LANGUAGES[0]) {
  const ranges = [];
  (header ?? '').split(',').forEach((part, i) => {
    const [range, ...params] = part.split(';').map((x) => x.trim());
    if (!RANGE.test(range)) return;
    let q = 1;
    for (const p of params) {
      const m = /^q=(0(\.\d{0,3})?|1(\.0{0,3})?)$/i.exec(p);
      if (!m) return;
      q = Number(m[1]);
    }
    if (q > 0) ranges.push({ range: range.toLowerCase(), q, i });
  });
  ranges.sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { range } of ranges) {
    for (let tag = range; tag;) {
      const hit = available.find((x) => x.toLowerCase() === tag);
      if (hit) return hit;
      const cut = tag.lastIndexOf('-');
      tag = cut < 0 ? '' : tag.slice(0, cut).replace(/-[a-z0-9]$/, '');
    }
  }
  return fallback;
}

// Well-formed language tag in lowercase (RFC 5646, 2.1), as in the reference.
const TAG = new RegExp('^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?' +
  '(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?' +
  '|x(?:-[a-z0-9]{1,8})+|en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)' +
  '|sgn-(?:be-fr|be-nl|ch-de)|art-lojban|cel-gaulish|no-bok|no-nyn|zh-(?:guoyu|hakka|min|min-nan|xiang))$');

// ── Utilities ─────────────────────────────────────────────────────────────────
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const etag = (value) => `"${hash(JSON.stringify(value))}"`;
const ptr = (f) => `/${f.replace(/~/g, '~0').replace(/\//g, '~1')}`;
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v));
const warnings = [];
const warn = (msg) => warnings.push(msg);

// Deterministic pseudo-random generator: each (seed, collection, item, field) has its own stream,
// so adding a field to the discovery document does not change the values of the others.
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rngFor = (...parts) => {
  const r = mulberry32(fnv(parts.join('|')));
  const api = () => r();
  api.int = (min, max) => min + Math.floor(r() * (max - min + 1));
  api.pick = (list) => list[Math.floor(r() * list.length)];
  api.chance = (p) => r() < p;
  return api;
};

// ── Loading the discovery document ────────────────────────────────────────────
const isUrl = (s) => /^https?:\/\//i.test(s);
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Cannot connect to ${url}: ${e.cause?.code ?? e.message}`);
  }
  if (!res.ok) throw new Error(`${url} answers ${res.status}.`);
  try { return { json: await res.json(), res }; } catch { throw new Error(`${url} does not return JSON.`); }
}
async function loadDiscovery(source) {
  let doc, base;
  if (isUrl(source)) {
    let { json, res } = await fetchJson(source);
    if (!isObject(json) || typeof json.restep !== 'string') {
      // 4.2: the document may be at another path, linked with rel="service-desc".
      const links = [...(res.headers.get('link') ?? '').matchAll(/<([^>]+)>\s*;[^,]*rel="?service-desc"?/g)].map((m) => new URL(m[1], source).href);
      for (const l of links) {
        const r = await fetchJson(l).catch(() => null);
        if (r && isObject(r.json) && typeof r.json.restep === 'string') { json = r.json; source = l; break; }
      }
    }
    doc = json; base = source;
  } else {
    let raw;
    try { raw = readFileSync(source, 'utf8'); } catch (e) { throw new Error(`Cannot read ${source}: ${e.code ?? e.message}`); }
    try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${source} is not valid JSON: ${e.message}`); }
    base = resolve(source);
  }
  if (!isObject(doc) || typeof doc.restep !== 'string')
    throw new Error(`${source} is not a Restep discovery document: it lacks the "restep" member (4.2).`);
  const v = RESTEP_VERSION.exec(doc.restep);
  if (!v || v[1] !== '1') throw new Error(`restep-mock only understands Restep 1 (major.minor[-draft.N|-rc.N], 1.1), and the document says ${JSON.stringify(doc.restep)}.`);
  // Linked schemas (4.3): read to generate and validate, and served at the same path.
  const linked = {};
  const actionInputs = (c) => Object.entries(isObject(c?.actions) ? c.actions : {}).map(([a, d]) => [`input of action ${a}`, d?.input]);
  for (const [name, c] of [...Object.entries(doc.collections ?? {}), ...Object.entries(isObject(doc.singletons) ? doc.singletons : {})]) {
    for (const [kind, s] of [...Object.entries(isObject(c?.schemas) ? c.schemas : {}), ...actionInputs(c)]) {
      if (typeof s !== 'string' || Object.hasOwn(linked, s)) continue;
      try {
        if (isUrl(base)) linked[s] = (await fetchJson(new URL(s, base).href)).json;
        else if (isUrl(s)) linked[s] = (await fetchJson(s)).json;
        else linked[s] = JSON.parse(readFileSync(resolve(dirname(base), `.${s.startsWith('/') ? s : `/${s}`}`), 'utf8'));
      } catch (e) {
        // An input's is reported by the action, which says what it does without it.
        if (!kind.startsWith('input')) warn(`Could not read the ${kind} schema of ${name} (${s}): ${e.message}. Using the types from discovery.`);
      }
    }
  }
  return { doc, linked };
}

// ── Model of each collection ──────────────────────────────────────────────────
const DECIMAL = /^-?\d+(\.\d+)?$/;
// 2 and 6.1: a numeric literal as its exact value, sign, significant digits and exponent, without floating point:
// "20", "20.0" and "2e1" give the same "2e1"; null if it is not a number.
function exactNumber(raw) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(raw);
  if (!m) return null;
  let digits = (m[2] + (m[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailing);
  return `${m[1]}${digits}e${BigInt(m[4] ?? 0) - BigInt((m[3] ?? '').length) + BigInt(trailing)}`;
}
// 6.1, 11.1: an integer or number operand (of a filter or of a GET action parameter) follows the number grammar
// of RFC 8259 (section 6), exponent included (2e1 is 20); +20, .5, 020 and 0x14 do not match it.
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;
// 5.3 and 6.1: the mock's limit on an integer or number operand, from its exact value: zero, or a magnitude from
// 1e-300 to 1e300. Within it, the operand is a finite, nonzero number; over it, numberOverLimit is true and the
// operand gives invalid_parameter with the limit in detail, never an infinity or zero in its place.
const NUMBER_LIMIT = 300n;
const numberOverLimit = (raw) => {
  const n = exactNumber(raw);
  if (!n || n === '0') return false;
  const [digits, exp] = n.replace(/^-/, '').split('e');
  const top = BigInt(digits.length - 1) + BigInt(exp); // the value is in [10^top, 10^(top+1))
  return top > NUMBER_LIMIT || (top === NUMBER_LIMIT && digits !== '1') || top < -NUMBER_LIMIT;
};
// 6.1: an integer operand is one whose exact decimal value has no fractional part: 20.0 is 20, 20.5 is not.
const integerLiteral = (raw) => { const n = JSON_NUMBER.test(raw) && exactNumber(raw); return typeof n === 'string' && (n === '0' || !n.split('e')[1].startsWith('-')); };
const looksDecimal = (pattern) => typeof pattern === 'string' && /(\\d|\[0-9\])\+\s*\(\s*\\\.\s*(\\d|\[0-9\])\+\s*\)\?/.test(pattern);
// Strips null from anyOf/oneOf/type: returns [schema without null, allows null].
function unwrap(s) {
  if (!isObject(s)) return [{}, false];
  for (const k of ['anyOf', 'oneOf']) {
    if (Array.isArray(s[k])) {
      const rest = s[k].filter((x) => !(isObject(x) && x.type === 'null'));
      if (rest.length < s[k].length) return [{ ...s, [k]: undefined, ...unwrap(rest.length === 1 ? rest[0] : { [k]: rest })[0] }, true];
    }
  }
  if (Array.isArray(s.type)) {
    const rest = s.type.filter((x) => x !== 'null');
    return [{ ...s, type: rest.length === 1 ? rest[0] : rest }, rest.length < s.type.length];
  }
  return [s, false];
}
function typeFromSchema(s) {
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string')) return 'enum';
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'string') {
    if (looksDecimal(s.pattern)) return 'decimal';
    if (s.format === 'date-time') return 'datetime';
    if (s.format === 'date') return 'date';
    if (s.format === 'duration') return 'duration';
    return 'string';
  }
  if (type === 'integer' || type === 'number' || type === 'boolean') return type;
  if (type === 'object' && isObject(s.properties) && s.properties.id) return 'relation';
  if (type === 'array' && isObject(s.items) && isObject(s.items.properties) && s.items.properties.id) return 'relation';
  if (type === 'object' && (s.propertyNames || isObject(s.additionalProperties))) return 'map';
  if (type === 'object' && isObject(s.properties)) return 'object'; // 11.6: an object of scalars (combine "fields")
  return undefined;
}
// With no schema or filter to say so, the type comes from the field's name.
function typeFromName(f) {
  if (/(^|_)(time_?zone|tz|zone)$/.test(f)) return 'timezone'; // 3: an IANA time zone name
  if (/(_at|_time|timestamp)$/.test(f)) return 'datetime';
  if (/(^date$|_date$|_on$|^birthday$)/.test(f)) return 'date';
  if (/(duration|_length$)/.test(f)) return 'duration';
  if (/^(is|has|can)_|^(active|enabled|published|available|visible|archived)$/.test(f)) return 'boolean';
  if (/(price|amount|cost|total|balance|fee|subtotal|tax_rate|vat)/.test(f)) return 'decimal';
  if (/(^year$|count$|_count|quantity|^qty$|stock|^age$|_seconds$|^pages$)/.test(f)) return 'integer';
  if (/(rating|score|^lat|^lng|^lon|latitude|longitude|weight|height)/.test(f)) return 'number';
  return 'string';
}

// ── Subcollections (4.2, 5.1) ─────────────────────────────────────────────────
const segsOf = (path) => path.split('/').filter(Boolean);
const isVar = (x) => /^\{[^{}]+\}$/.test(x);
function scope(coll, key = '') {
  let rows = coll.scopes.get(key);
  if (!rows) { rows = new Map(); coll.scopes.set(key, rows); }
  return rows;
}
function usedOf(coll, key = '') {
  let used = coll.usedByKey.get(key);
  if (!used) { used = new Set(); coll.usedByKey.set(key, used); }
  return used;
}
function* entries(coll) { for (const [key, rows] of coll.scopes) for (const row of rows.values()) yield [key, row]; }
// 5.1: an item's path is its collection's, with the template filled with its parents' ids, / and its id.
function itemPath(coll, key, id) {
  const ids = key ? key.split('/') : [];
  let k = 0;
  return `/${coll.segs.map((x) => (isVar(x) ? ids[k++] : x)).join('/')}${id === undefined ? '' : `/${id}`}`;
}
const childKey = (key, id) => (key ? `${key}/${id}` : id);
// A collection seen in a scope (the items under a parent): inherits everything and changes rows, used and path.
function view(coll, key = '') {
  const v = Object.create(coll);
  v.rows = scope(coll, key); v.used = usedOf(coll, key); v.key = key; v.path = itemPath(coll, key);
  return v;
}
// What a path is, in already decoded segments: { coll, key, id }. The template with the most literals wins and,
// on a tie, the collection over the item.
function match(db, segments) {
  let best = null;
  for (const coll of Object.values(db)) {
    const L = coll.segs.length;
    for (const item of [false, true]) {
      if (segments.length !== L + (item ? 1 : 0) || (item && !segments[L])) continue;
      const ids = [];
      let ok = true;
      for (let i = 0; i < L && ok; i++) {
        if (isVar(coll.segs[i])) { if (segments[i]) ids.push(segments[i]); else ok = false; } else ok = coll.segs[i] === segments[i];
      }
      if (!ok) continue;
      const literals = coll.segs.filter((x) => !isVar(x)).length;
      if (!best || literals > best.literals || (literals === best.literals && !item && best.id !== undefined))
        best = { coll, key: ids.join('/'), id: item ? segments[L] : undefined, literals };
    }
  }
  return best;
}
// Whether the parent item of a scope exists (and so the whole chain: deleting a parent deletes its scopes).
function parentExists(db, coll, key) {
  if (!coll.parent) return true;
  const ids = key.split('/');
  return db[coll.parent].scopes.get(ids.slice(0, -1).join('/'))?.has(ids.at(-1)) ?? false;
}
// An href (absolute path or URI): { coll, key, id, row } if it is the path of a simulated item.
function parseHref(db, href) {
  if (typeof href !== 'string') return null;
  let segments;
  try { segments = new URL(href, 'http://localhost').pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  const m = match(db, segments);
  return m && m.id !== undefined ? { ...m, row: m.coll.scopes.get(m.key)?.get(m.id) } : null;
}

// 11.1: an action declaration, or null (with a warning) if the mock does not serve it. A collection's carries on;
// a singleton's does not.
function parseAction(owner, a, d, collection, linked) {
  const method = d?.method ?? 'POST';
  const why = !isObject(d) ? 'not an object' : !NAME.test(a) ? 'its name does not follow the grammar of §3' : a === 'changes' ? 'changes belongs to sync'
    : collection && !['item', 'collection'].includes(d.on) ? `on ${JSON.stringify(d.on)}` : !collection && d.on !== undefined ? 'on in an action of a singleton'
    : typeof d.safe !== 'boolean' || typeof d.idempotent !== 'boolean' ? 'safe or idempotent is missing'
    : d.safe && !d.idempotent ? 'a safe action that is not idempotent (11.1)'
    : !['GET', 'POST'].includes(method) ? `method ${JSON.stringify(method)}` : method === 'GET' && !d.safe ? 'GET on an action that is not safe'
    : method === 'GET' && d.input !== undefined ? 'GET with input' : method !== 'GET' && d.params !== undefined ? 'params on an action that is not GET'
    : !d.safe && d.output !== undefined ? 'output on an action that is not safe'
    : a === 'new' && (d.on !== 'collection' || !d.safe || method !== 'GET') ? 'an action named new that is not a safe GET collection action (11.1)' : null;
  if (why) { warn(`${owner}:${a}: ${why}; neither simulated nor served.`); return null; }
  const input = typeof d.input === 'string' ? linked[d.input] : d.input;
  if (typeof d.input === 'string' && !input) warn(`${owner}:${a}: could not read its input (${d.input}); any object is accepted.`);
  const output = typeof d.output === 'string' ? linked[d.output] : d.output;
  // 11.1: the query parameters of a GET action, with a type of 4.2.
  const params = Object.fromEntries(Object.entries(isObject(d.params) ? d.params : {})
    .filter(([p, x]) => NAME.test(p) && isObject(x) && typeof x.type === 'string')
    .map(([p, x]) => [p, { type: x.type, values: Array.isArray(x.values) ? x.values : null, list: x.list === true, required: x.required === true }]));
  return { on: d.on, safe: d.safe, idempotent: d.idempotent, method, input: isObject(input) ? input : null, output: isObject(output) ? output : null, params };
}

function buildModel(doc, linked) {
  const profiles = (Array.isArray(doc.profiles) ? doc.profiles : ['core']).filter((p) => typeof p === 'string');
  const unsupportedProfiles = profiles.filter((p) => !SUPPORTED_PROFILES.includes(p));
  const extensions = (Array.isArray(doc.extensions) ? doc.extensions : []).filter((x) => typeof x === 'string');
  if (unsupportedProfiles.length) warn(`Not implemented: ${unsupportedProfiles.join(', ')}; removed from profiles in the served discovery.`);
  const dropped = extensions.filter((x) => !SUPPORTED_EXTENSIONS.includes(x));
  if (dropped.length) warn(`Not implemented: ${dropped.join(', ')}; removed from extensions in the served discovery.`);
  const active = profiles.filter((p) => SUPPORTED_PROFILES.includes(p));
  if (!active.includes('core')) active.unshift('core');
  // 5.5: an expired profile notice retires the profile, and with it those that need it (1.2).
  const now = Date.now();
  const due = (d) => isObject(d) && typeof d.sunset === 'string' && Date.parse(d.sunset) <= now;
  for (const d of Array.isArray(doc.deprecations) ? doc.deprecations : []) {
    if (!due(d) || d.kind !== 'profile' || !active.includes(d.name)) continue;
    warn(`Profile ${d.name} was retired on ${d.sunset}: not announced.`);
    active.splice(active.indexOf(d.name), 1);
  }
  const has = (p) => active.includes(p);
  const served = structuredClone({ ...doc, restep: RESTEP, profiles: active, extensions: [] });
  if (doc.restep !== RESTEP) warn(`The document declares "restep": ${JSON.stringify(doc.restep)}; the mock implements draft 7 and serves "${RESTEP}".`);
  for (const k of ['batch', 'events']) if (k in served) { delete served[k]; }
  // 7.1: anonymous can only be false (keys without credentials are rejected) or absent.
  if (isObject(served.idempotency) && served.idempotency.anonymous !== undefined && served.idempotency.anonymous !== false) delete served.idempotency.anonymous;
  served.collections = {};
  const db = {};
  // 4.2: shared_cache is reserved for a minor version; a server of this version MUST NOT send it.
  if ('shared_cache' in served) { delete served.shared_cache; warn('shared_cache is reserved (4.2): removed from the served discovery.'); }
  for (const [name, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string' || !c.path.startsWith('/')) { warn(`Collection ${name} has no valid path: left out.`); continue; }
    const path = c.path.replace(/\/+$/, '') || '/';
    if (path === '/') { warn(`Collection ${name} is at the root: left out.`); continue; }
    const schemaOf = (k) => { const s = c.schemas?.[k]; return typeof s === 'string' ? linked[s] : s; };
    const item = schemaOf('item'), create = schemaOf('create'), update = schemaOf('update');
    const props = { ...(isObject(create?.properties) ? create.properties : {}), ...(isObject(item?.properties) ? item.properties : {}) };
    const filter = isObject(c.filter) ? c.filter : {};
    const relations = {};
    for (const [r, d] of Object.entries(isObject(c.relations) ? c.relations : {})) {
      if (!isObject(d) || d.to === undefined) continue;
      relations[r] = { to: d.to, many: d.many === true, include: d.include === true, path: typeof d.path === 'string' ? d.path : undefined,
        mediaTypes: Array.isArray(d.media_types) ? d.media_types.filter((m) => typeof m === 'string').map((m) => m.toLowerCase()) : null };
    }
    const mapsDecl = isObject(c.language_maps) ? Object.keys(c.language_maps) : [];
    // 3: localized fields, each the text of a language map of the same item in the language of the response.
    const localized = {};
    for (const [f, d] of Object.entries(isObject(c.localized) ? c.localized : {})) {
      if (isObject(d) && typeof d.source === 'string' && mapsDecl.includes(d.source) && !mapsDecl.includes(f)) localized[f] = d.source;
      else warn(`${name}.localized.${f}: its source is not a language map of ${name}; not served.`);
    }
    // 3 and 4.2: fields that hold local date-times.
    const localTimes = isObject(c.local_times) ? Object.keys(c.local_times) : [];
    const inherit = {};
    for (const [f, d] of Object.entries(isObject(c.inherit) ? c.inherit : {})) {
      // 11.6: combine ("replace" or "fields") and switch (a boolean field of the item; while false, nothing comes
      // from above). A declaration with another combine is not simulated.
      if (isObject(d) && typeof d.own === 'string' && Array.isArray(d.from) && [undefined, 'replace', 'fields'].includes(d.combine))
        inherit[f] = { own: d.own, from: d.from, default: d.default === true, combine: d.combine ?? 'replace',
          switch: isObject(d.switch) && typeof d.switch.field === 'string' && typeof d.switch.initial === 'boolean' ? d.switch : null };
      else if (isObject(d)) warn(`${name}.inherit.${f}: combine ${JSON.stringify(d.combine)} is not simulated; inheritance ignored.`);
    }
    // Fields: those of the schema and, if there is none, all those the discovery document names.
    const names = new Set(['id', ...Object.keys(props)]);
    if (!item) {
      for (const f of Object.keys(filter)) if (!f.includes('.')) names.add(f);
      for (const s of Array.isArray(c.sort) ? c.sort : []) if (typeof s === 'string' && !s.includes('.')) names.add(s);
      for (const f of mapsDecl) names.add(f);
      for (const f of Object.keys(relations)) names.add(f);
      for (const [f, d] of Object.entries(inherit)) { names.add(f); names.add(d.own); }
      for (const f of Object.keys(filter)) if (f.includes('.') && !mapsDecl.includes(f.split('.')[0])) names.add(f.split('.')[0]);
      for (const f of [...Object.keys(localized), ...localTimes]) names.add(f);
    }
    for (const f of Object.keys(localized)) names.add(f);
    const types = {}, values = {}, nullable = {}, constraints = {};
    // 6.1: fields whose value is a list of scalars, with the type of their elements.
    const lists = {};
    for (const f of names) {
      const [s, isNull] = unwrap(props[f]);
      nullable[f] = isNull;
      constraints[f] = s;
      if (!relations[f] && !mapsDecl.includes(f) && (s.type === 'array' || (!item && filter[f]?.quantifier === 'some' && !f.includes('.')))) {
        const [el] = unwrap(isObject(s.items) ? s.items : {});
        lists[f] = filter[f]?.type ?? typeFromSchema(el) ?? 'string';
        types[f] = 'list';
        if (lists[f] === 'enum') values[f] = filter[f]?.values ?? el.enum ?? ['a', 'b', 'c'];
        constraints[f] = el;
        continue;
      }
      let type = f === 'id' ? 'string'
        : localized[f] ? 'localized'
        : mapsDecl.includes(f) ? 'map'
        : relations[f] ? 'relation'
        : localTimes.includes(f) ? 'localdatetime'
        : filter[f]?.type ?? typeFromSchema(s);
      // The effective type and the own type of an inheritance are the same.
      if (!type) {
        const pair = Object.entries(inherit).find(([e, d]) => e === f || d.own === f);
        if (pair) type = filter[pair[0]]?.type ?? filter[pair[1].own]?.type ?? typeFromSchema(unwrap(props[pair[0]])[0]) ?? typeFromSchema(unwrap(props[pair[1].own])[0]);
      }
      if (!type && f.includes('.')) continue;
      // 3: a string field named as a time zone, or the zone of a local time, holds an IANA zone name.
      if ((type === 'string' || !type) && (typeFromName(f) === 'timezone' || Object.values(isObject(c.local_times) ? c.local_times : {}).some((d) => d?.zone === f))) type = 'timezone';
      types[f] = type ?? typeFromName(f);
      if (types[f] === 'enum') values[f] = filter[f]?.values ?? s.enum ?? ['a', 'b', 'c'];
      if (relations[f] && relations[f].many === false && (s.type === 'array' || s.items)) relations[f].many = true;
    }
    for (const [f, d] of Object.entries(inherit)) {
      if (!types[f] || !types[d.own]) { warn(`${name}.inherit.${f}: ${f} or ${d.own} is missing; inheritance ignored.`); delete inherit[f]; continue; }
      types[d.own] = types[f]; if (types[f] === 'enum') values[d.own] = values[f];
    }
    for (const d of Object.values(inherit)) if (d.switch && !types[d.switch.field]) types[d.switch.field] = 'boolean';
    for (const f of mapsDecl) if (!types[f]) types[f] = 'map';
    for (const r of Object.keys(relations)) if (!types[r]) types[r] = 'relation';
    let required = Array.isArray(create?.required) ? create.required.filter((f) => f in types && f !== 'id')
      : Array.isArray(item?.required) ? item.required.filter((f) => f in types && f !== 'id') : [];
    // 4.3: a default on a top-level property of create is the value of a field the POST does not carry.
    const createDefaults = Object.fromEntries(Object.entries(isObject(create?.properties) ? create.properties : {})
      .filter(([f, d]) => f in types && f !== 'id' && isObject(d) && Object.hasOwn(d, 'default')).map(([f, d]) => [f, structuredClone(d.default)]));
    // 11.6: a POST that leaves the switch out gives it its initial value.
    for (const d of Object.values(inherit)) if (d.switch && !Object.hasOwn(createDefaults, d.switch.field)) createDefaults[d.switch.field] = d.switch.initial;
    const methods = Array.isArray(c.methods) ? [...c.methods] : ['GET', 'POST'];
    const itemMethods = Array.isArray(c.item_methods) ? [...c.item_methods] : ['GET', 'PATCH', 'DELETE'];
    // 5.1: who chooses the id. A value that draft 6 does not define is not simulated.
    let idFrom = c.id_from ?? 'server';
    if (!['server', 'client', 'either'].includes(idFrom)) { warn(`${name}.id_from ${JSON.stringify(c.id_from)} is not simulated: served without it (the server picks).`); idFrom = 'server'; }
    // 6.1: collations. "codepoint" is the usual; any other value is compared as "server" (without
    // case or accents), which is what a client has to assume for a value it does not know.
    const collations = Object.fromEntries(Object.entries(isObject(c.collations) ? c.collations : {}).filter(([, v]) => v !== 'codepoint'));
    // 5.1: read-only fields, those the item schema marks readOnly in its properties (id and the effective ones go apart).
    const readOnly = Object.entries(isObject(item?.properties) ? item.properties : {})
      .filter(([f, d]) => f !== 'id' && isObject(d) && d.readOnly === true && !inherit[f] && !localized[f] && f in types).map(([f]) => f);
    const idSchema = isObject(create?.properties?.id) ? create.properties.id : {};
    // 5.1: a field only the server sets is one no client can set directly, in a POST or a PATCH (created_at, a
    // total). Discovery cannot say which: neither readOnly in the item schema nor absence from create establishes
    // it. So the mock takes only the fields its own member x-mock-server-only lists: a POST ignores them whatever
    // their value, and a PATCH treats them as read-only. Never id, an effective field or a localized one.
    const serverOnly = [];
    const marked = c['x-mock-server-only'];
    if (marked !== undefined && !Array.isArray(marked)) warn(`${name}.x-mock-server-only is a list of field names: ignored.`);
    for (const f of Array.isArray(marked) ? marked : []) {
      if (typeof f !== 'string' || f === 'id' || !(f in types) || inherit[f] || localized[f]) {
        warn(`${name}.x-mock-server-only: ${JSON.stringify(f)} is not a field the server alone can set (5.1: never id, an effective or a localized field): ignored.`);
        continue;
      }
      serverOnly.push(f);
      if (!readOnly.includes(f)) readOnly.push(f);
    }
    // 5.1: reusable_ids only with "client", upsert with "client" or "either".
    const reusableIds = c.reusable_ids === true && idFrom === 'client';
    if (c.reusable_ids === true && !reusableIds) warn(`${name}.reusable_ids needs "id_from": "client" (5.1): served without it.`);
    const upsert = c.upsert === true && (idFrom === 'client' || idFrom === 'either') && itemMethods.includes('PATCH');
    if (c.upsert === true && !upsert) warn(`${name}.upsert needs "id_from" "client" or "either" and PATCH on items (5.1): served without it.`);
    // 5.1: upload, a POST that carries the bytes of a file instead of JSON.
    let upload = null;
    if (c.upload !== undefined) {
      const u = c.upload;
      if (isObject(u) && Array.isArray(u.media_types) && u.media_types.length && u.media_types.every((m) => typeof m === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(m)) && methods.includes('POST'))
        upload = { media_types: u.media_types.map((m) => m.toLowerCase()), max_size: Number.isInteger(u.max_size) && u.max_size > 0 ? u.max_size : null, multipart: u.multipart === true,
          // 5.1: discovery has no member for a collection that does not create items from JSON; the mock, like
          // restep-check, takes one with upload and without a create schema as such. A JSON body there is a file
          // where media_types declares application/json, and otherwise gets 415.
          onlyFiles: c.schemas?.create === undefined };
      else warn(`${name}.upload is not valid, or the collection has no POST (5.1): served without it.`);
      // 5.1: in a collection that also creates from JSON, a POST with application/json is always an item, so a JSON
      // file only comes as the file part of multipart/form-data: media_types that admit application/json (also
      // through a wildcard) require "multipart": true.
      if (upload && !upload.onlyFiles && !upload.multipart && upload.media_types.some((r) => r === '*/*' || r === 'application/json' || r === 'application/*')) {
        warn(`${name}.upload: creates items from JSON and its media_types admit application/json, which requires "multipart": true (5.1): served with it.`);
        upload.multipart = true;
      }
    }
    db[name] = {
      name, path, description: c.description, createSchema: isObject(create) ? create : null, methods, item_methods: itemMethods, types, values, nullable, constraints, required,
      idFrom, collations, readOnly, serverOnly, idPattern: typeof idSchema.pattern === 'string' ? idSchema.pattern : null,
      localized, lists, reusableIds, upsert, upload, files: new Map(), incarnations: new Map(),
      // 4.2: a subcollection has a template in path and its parent; its items go by scopes, one per
      // parent item (the key is the list of the parents' ids, separated by /).
      segs: segsOf(path), parent: typeof c.parent === 'string' ? c.parent : undefined, scopes: new Map(), usedByKey: new Map(),
      actions: {},
      filter: Object.fromEntries(Object.entries(filter).filter(([, d]) => isObject(d) && Array.isArray(d.ops)).map(([f, d]) => [f, d])),
      // 6.1: named filters. Their meaning is only in the description, so the mock deterministically
      // picks a part of the items for each name and value.
      // 6.1: a switch may apply by default ("default": true) and any filter may be required.
      named: has('query') && isObject(c.named_filters)
        ? Object.fromEntries(Object.entries(c.named_filters).filter(([f, d]) => isObject(d) && !f.includes('.') && !Object.hasOwn(filter, f))
          .map(([f, d]) => [f, { type: typeof d.type === 'string' ? d.type : null, values: Array.isArray(d.values) ? d.values : null,
            default: d.default === true && typeof d.type !== 'string', required: d.required === true }]))
        : {},
      // 6.2: only the declared keys; without a declared sort, sort=id gives unsupported_parameter. The default
      // order (5.2) is by id anyway.
      sort: has('query') && Array.isArray(c.sort) ? [...c.sort] : [],
      // 6.4: limit is accepted only where max_limit is declared; without it, pages have 20.
      max_limit: Number.isInteger(c.max_limit) && c.max_limit > 0 ? c.max_limit : null,
      count: has('query') && (c.count === 'exact' || c.count === 'estimated') ? c.count : null,
      relations, inherit, includeDepth: Number.isInteger(c.include_depth) ? c.include_depth : 1,
      closedUpdate: isObject(update) && update.additionalProperties === false,
      tags: {}, defaults: {}, createDefaults, nextId: 1,
    };
    if (!db[name].parent && !/[{}]/.test(path)) { db[name].rows = scope(db[name], ''); db[name].used = usedOf(db[name], ''); }
    const out = structuredClone(c);
    delete out.sync;
    if ('sync' in c) warn(`${name}: sync is not implemented; removed from the served discovery.`);
    // 11.6: inherited items are not simulated; 4.2: shared_cache is reserved.
    if ('inherit_items' in c) { delete out.inherit_items; warn(`${name}: inherit_items (11.6) is not simulated; removed from the served discovery.`); }
    if ('shared_cache' in c) { delete out.shared_cache; warn(`${name}: shared_cache is reserved (4.2); removed from the served discovery.`); }
    if (isObject(out.localized)) {
      for (const f of Object.keys(out.localized)) if (!localized[f]) delete out.localized[f];
      if (!Object.keys(out.localized).length) delete out.localized;
    }
    if (!reusableIds) delete out.reusable_ids;
    if (!upsert) delete out.upsert;
    if (!upload) delete out.upload;
    else if (upload.multipart && out.upload.multipart !== true) out.upload = { ...out.upload, multipart: true }; // fixed above (5.1)
    // 11.1: actions. Each with on, safe and idempotent; GET only if safe and then without input; none is
    // called changes. What does not fit (or an on or method that draft 6 does not define) is not served.
    if (isObject(c.actions)) {
      out.actions = {};
      for (const [a, d] of Object.entries(c.actions)) {
        const action = parseAction(name, a, d, true, linked);
        if (!action) continue;
        db[name].actions[a] = action;
        out.actions[a] = structuredClone(d);
      }
      if (!Object.keys(out.actions).length) delete out.actions;
    }
    if (c.id_from !== undefined && idFrom === 'server' && c.id_from !== 'server') delete out.id_from;
    served.collections[name] = out;
  }
  // 4.2: each subcollection names in parent the collection it hangs from, and its path is that collection's,
  // /, a variable of its own and what follows with no more variables. The variables have distinct names. What does not
  // fit (or hangs from something that is not simulated) is omitted, and with it its descendants.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, coll] of Object.entries(db)) {
      const vars = coll.segs.filter(isVar), names = vars.map((v) => v.slice(1, -1));
      const P = coll.parent !== undefined ? db[coll.parent] : null;
      const at = P ? P.segs.length : 0;
      const why = new Set(names).size !== names.length ? 'has repeated variables'
        : !vars.length ? (coll.parent !== undefined ? 'declares parent but its path has no template' : null)
        : coll.parent === undefined ? 'has a template but no parent'
        : !P ? `hangs from ${coll.parent}, which is not simulated`
        : P.segs.filter(isVar).length !== vars.length - 1 || !P.segs.every((x, i) => coll.segs[i] === x) || !isVar(coll.segs[at])
          || coll.segs.length === at + 1 || coll.segs.slice(at + 1).some(isVar) ? `its path is not that of ${coll.parent} followed by /{variable}/…` : null;
      if (!why) continue;
      warn(`Subcollection ${name} (${coll.path}) ${why}: left out.`);
      delete db[name]; delete served.collections[name]; changed = true;
    }
  }
  for (const coll of Object.values(db)) {
    coll.ancestors = [];
    for (let p = coll.parent; p; p = db[p].parent) coll.ancestors.unshift(p);
  }
  // 6.1: paths through a to-many relation, or ending in the id of a relation whose target is a subcollection
  // (that id only identifies under its parent), are not declared in filter or sort.
  for (const [name, coll] of Object.entries(db)) {
    const out = served.collections[name];
    // 6.1: a path through one to-many relation, or a list field, is declared only with "quantifier": "some";
    // never one through two to-many steps, nor one that ends in the id of an item of a subcollection.
    const toMany = (k) => {
      const segs = k.split('.');
      if (segs.length === 1) return coll.types[k] === 'list' ? 1 : 0;
      let c = coll, n = 0;
      for (const s of segs.slice(0, -1)) {
        const d = c?.relations[s];
        if (!d) return n;
        if (d.many) n++;
        c = Array.isArray(d.to) ? null : db[d.to];
      }
      return n;
    };
    const subcollectionId = (k) => {
      const [head, next] = k.split('.');
      const d = coll.relations[head];
      return Boolean(d && next === 'id' && k.split('.').length === 2 && [].concat(d.to).some((to) => db[to]?.parent));
    };
    const drop = (k, why) => { warn(`${name}: filter[${k}] ${why}: not served.`); delete coll.filter[k]; delete out.filter?.[k]; };
    for (const [k, d] of Object.entries(coll.filter)) {
      if (d.quantifier !== undefined && d.quantifier !== 'some') { drop(k, `declares quantifier ${JSON.stringify(d.quantifier)}, reserved for minor versions (6.1)`); continue; }
      const steps = toMany(k);
      if (subcollectionId(k)) { drop(k, 'ends in the id of an item of a subcollection (6.1)'); continue; }
      if (steps > 1) { drop(k, 'goes through more than one to-many step (6.1)'); continue; }
      const nullOnly = !k.includes('.') && d.ops.every((op) => op === 'null'); // the relation or list itself (below)
      // 6.1: the to-many relation or list field itself, with null as its only operator, may omit quantifier or
      // declare "some" (both select the same), and has the type of the related items' id (string) or of the elements.
      const itself = nullOnly && (coll.relations[k]?.many || coll.types[k] === 'list');
      const wanted = coll.relations[k]?.many ? 'string' : coll.lists[k];
      if (itself && wanted && d.type !== wanted && !(wanted === 'enum' && d.type === 'enum')) {
        warn(`${name}: filter[${k}] declares type ${JSON.stringify(d.type)}, but its null takes ${coll.relations[k]?.many ? 'that of the related items\' id' : 'that of its elements'}, ${wanted} (6.1): served with ${wanted}.`);
        coll.filter[k] = { ...coll.filter[k], type: wanted }; out.filter[k].type = wanted;
      }
      if (itself) continue; // null only: no other rule of this loop applies
      if (steps === 1 && d.quantifier !== 'some' && !nullOnly) { drop(k, 'goes through a to-many relation or is a list, without "quantifier": "some" (6.1)'); continue; }
      if (steps === 0 && d.quantifier !== undefined) { drop(k, 'declares quantifier but is not a path through a to-many relation nor a list (6.1)'); continue; }
      // 6.1: only the operators of the list; prefix and contains only on strings and never on id; ne and nin
      // never with quantifier.
      const ops = d.ops.filter((op) => OPERATORS.includes(op) && !((op === 'prefix' || op === 'contains') && (d.type !== 'string' || k === 'id'))
        && !(d.quantifier && (op === 'ne' || op === 'nin')));
      if (ops.length !== d.ops.length) {
        warn(`${name}: filter[${k}] declares ${d.ops.filter((op) => !ops.includes(op)).join(', ')}, which 6.1 does not allow there: not served.`);
        if (!ops.length) { drop(k, 'has no operator left'); continue; }
        coll.filter[k] = { ...d, ops }; out.filter[k].ops = ops;
      }
    }
    for (const k of [...coll.sort]) {
      const ok = !subcollectionId(k) && (toMany(k) === 0 || (toMany(k) === 1 && coll.filter[k]?.quantifier === 'some'));
      if (!ok) { warn(`${name}: sort ${k} cannot be declared (6.1): not served.`); coll.sort.splice(coll.sort.indexOf(k), 1); out.sort?.splice(out.sort.indexOf(k), 1); }
    }
    // 6.1: a relation or a list field itself may declare null (filter[reviews][null]).
    for (const [k, d] of Object.entries(coll.filter)) if (!k.includes('.') && coll.relations[k]?.many && d.ops.some((op) => op !== 'null')) {
      warn(`${name}: filter[${k}] is a to-many relation, which only declares null (6.1): served with null only.`);
      coll.filter[k] = { ...d, ops: ['null'] }; out.filter[k].ops = ['null'];
    }
    // 9: a to-many relation whose path is the template of a subcollection of this collection leads to it. It is not
    // embedded in the representation (that is what the subcollection is for); with include, if expandable, it brings its
    // items under that parent. It is not written.
    for (const [r, d] of Object.entries(coll.relations)) {
      const sub = typeof d.to === 'string' ? db[d.to] : null;
      const shape = (segs) => segs.map((x) => (isVar(x) ? '{}' : x)).join('/');
      if (d.many && sub?.parent === name && typeof d.path === 'string' && shape(segsOf(d.path)) === shape(sub.segs)) d.derived = d.to;
    }
  }
  // 11.1 and 11.6: the extensions that are simulated and that some collection uses are announced.
  const inherits = Object.values(db).some((c) => Object.keys(c.inherit).length);
  const acts = Object.values(db).some((c) => Object.keys(c.actions).length)
    || Object.values(isObject(doc.singletons) ? doc.singletons : {}).some((c) => isObject(c?.actions) && Object.keys(c.actions).length);
  served.extensions = [...(acts ? ['actions'] : []), ...(inherits ? ['inherit'] : [])];
  if (acts && !extensions.includes('actions')) warn('Some collections have actions but extensions does not announce actions: announced in the served discovery.');
  if (inherits && !extensions.includes('inherit')) warn('Some collections have inherit but extensions does not announce inherit (11.6): announced in the served discovery.');
  for (const [name, c] of Object.entries(served.collections)) if (!Object.keys(db[name].inherit).length) delete c.inherit;

  // 5.9: singletons. One may hang from an item (its path is a template that starts with the parent's item path)
  // or from another singleton (its path starts with the parent's); without parent, its path is not a template.
  const singletons = {};
  served.singletons = {};
  const docSingletons = isObject(doc.singletons) ? doc.singletons : {};
  const underSingleton = (c) => isObject(c) && typeof c.parent === 'string' && Object.hasOwn(docSingletons, c.parent);
  // 5.9: a path that a collection or an item of one has or could have (an item's path is its collection's
  // followed by one segment); a variable matches any segment.
  const clashes = (segs) => Object.values(db).some((x) => (segs.length === x.segs.length || segs.length === x.segs.length + 1)
    && x.segs.every((v, i) => isVar(v) || isVar(segs[i]) || v === segs[i]));
  for (const [name, c] of Object.entries(docSingletons).sort(([, a], [, b]) => underSingleton(a) - underSingleton(b))) {
    if (!isObject(c) || typeof c.path !== 'string' || !c.path.startsWith('/')) { warn(`Singleton ${name} has an invalid path: left out.`); continue; }
    const path = c.path.replace(/\/+$/, '');
    const segs = segsOf(path), vars = segs.filter(isVar), P = typeof c.parent === 'string' ? db[c.parent] : null, S = typeof c.parent === 'string' ? singletons[c.parent] : null;
    const why = c.parent === undefined ? (vars.length ? 'has a template but no parent (5.9)' : null)
      : typeof c.parent !== 'string' || (!P && !S) ? `names as parent ${JSON.stringify(c.parent)}, which is not simulated`
      : S ? (S.parent !== undefined || vars.length || !path.startsWith(`${S.path}/`) ? `does not hang from ${c.parent} as 5.9 says` : null)
      : new Set(vars).size !== vars.length || P.segs.filter(isVar).length !== vars.length - 1 || !P.segs.every((x, i) => segs[i] === x)
        || !isVar(segs[P.segs.length]) || segs.length === P.segs.length + 1 || segs.slice(P.segs.length + 1).some(isVar) ? `its path is not the item path of ${c.parent} followed by / and literal segments (5.9)` : null;
    if (why) { warn(`Singleton ${name} (${path}) ${why}: left out.`); continue; }
    if (clashes(segs)) { warn(`Singleton ${name} (${path}) clashes with a collection or its items: left out.`); continue; }
    const schemaOf = (k) => { const s = c.schemas?.[k]; return typeof s === 'string' ? linked[s] : s; };
    const item = schemaOf('item'), update = schemaOf('update');
    const props = { ...(isObject(update?.properties) ? update.properties : {}), ...(isObject(item?.properties) ? item.properties : {}) };
    const types = {}, values = {}, nullable = {}, constraints = {};
    for (const [f, d] of Object.entries(props)) {
      const [sch, isNull] = unwrap(d);
      const type = typeFromSchema(sch) ?? typeFromName(f);
      if (type === 'relation' || type === 'map') { warn(`${name}.${f}: the mock does not simulate relations or language maps in a singleton; field left out.`); continue; }
      types[f] = type; nullable[f] = isNull; constraints[f] = sch;
      if (type === 'enum') values[f] = sch.enum ?? ['a', 'b', 'c'];
    }
    const methods = (Array.isArray(c.methods) ? c.methods : ['GET']).filter((m) => m === 'GET' || m === 'PATCH');
    if (!methods.includes('GET')) methods.unshift('GET');
    const readOnly = Object.entries(isObject(item?.properties) ? item.properties : {}).filter(([f, d]) => f in types && isObject(d) && d.readOnly === true).map(([f]) => f);
    if ('id' in types && !readOnly.includes('id')) readOnly.push('id'); // 5.9: a singleton's id is read-only
    // 11.1: actions of a singleton, used at {path}:{name}.
    const actions = {}, servedActions = {};
    for (const [a, d] of Object.entries(isObject(c.actions) ? c.actions : {})) {
      const action = parseAction(name, a, d, false, linked);
      if (action) { actions[a] = action; servedActions[a] = structuredClone(d); }
    }
    if ('shared_cache' in c) warn(`Singleton ${name}: shared_cache is reserved (4.2); removed from the served discovery.`);
    singletons[name] = { name, path, segs, parent: P ? P.name : S ? S.name : undefined, rows: new Map(), actions, methods, types, values, nullable, constraints, readOnly, singleton: true,
      required: Array.isArray(item?.required) ? item.required.filter((f) => f in types) : [], relations: {}, inherit: {}, tags: {},
      closedUpdate: isObject(update) && update.additionalProperties === false, row: {} };
    served.singletons[name] = structuredClone(c);
    delete served.singletons[name].shared_cache;
    // 4.3 and 5.9: a singleton MAY declare method_effects, whose only key can be PATCH (a PATCH it declares). Served
    // as it comes, like a collection's (they change no behaviour); another key is not served.
    if ('method_effects' in c) {
      const me = c.method_effects;
      const bad = !isObject(me) ? ['(not an object)'] : Object.keys(me).filter((m) => m !== 'PATCH' || !methods.includes('PATCH'));
      if (bad.length) {
        warn(`Singleton ${name}: method_effects only takes PATCH, and only where the singleton supports it (4.3, 5.9): ${bad.join(', ')} not served.`);
        const kept = isObject(me) ? Object.fromEntries(Object.entries(me).filter(([m]) => !bad.includes(m))) : {};
        if (Object.keys(kept).length) served.singletons[name].method_effects = kept; else delete served.singletons[name].method_effects;
      }
    }
    if (Object.keys(servedActions).length) served.singletons[name].actions = servedActions; else delete served.singletons[name].actions;
  }
  if (!Object.keys(served.singletons).length && !isObject(doc.singletons)) delete served.singletons;

  // 5.5: sunset notices. Each kind in its place; one that is not where it belongs is not served. Once its date has
  // passed, the retirement is enforced (RETIRES) or the notice is not served.
  const notices = [];
  const takeNotices = (list, scope, owner, setList) => {
    const kept = [];
    for (const d of Array.isArray(list) ? list : []) {
      if (!isObject(d) || !KINDS[scope].includes(d.kind)) { warn(`Deprecation with kind ${JSON.stringify(d?.kind)} out of place (${scope}${owner ? ` ${owner}` : ''}): not served.`); continue; }
      // 5.5: discovery keeps a notice after its sunset, until the next major version.
      kept.push(d);
      if (due(d) && d.kind === 'profile') continue; // already applied above
      if (due(d) && !RETIRES.includes(d.kind)) { warn(`Deprecation ${d.kind} ${d.name ?? ''} expired on ${d.sunset} and the mock does not simulate that retirement: served, but not applied.`); continue; }
      notices.push({ ...d, scope, owner, due: due(d) });
    }
    setList(kept);
  };
  takeNotices(doc.deprecations, 'root', null, (k) => { if (k.length) served.deprecations = k; else delete served.deprecations; });
  for (const [name, c] of Object.entries(served.collections))
    if (Array.isArray(c.deprecations)) takeNotices(c.deprecations, 'collection', name, (k) => { if (k.length) c.deprecations = k; else delete c.deprecations; });
  for (const [name, c] of Object.entries(served.singletons ?? {}))
    if (Array.isArray(c.deprecations)) takeNotices(c.deprecations, 'singleton', name, (k) => { if (k.length) c.deprecations = k; else delete c.deprecations; });
  for (const n of notices.filter((x) => x.due)) retire(n, db, singletons, served);
  for (const coll of Object.values(db)) {
    for (const [r, d] of Object.entries(coll.relations)) {
      const targets = [].concat(d.to);
      if (!targets.every((to) => db[to])) {
        warn(`${coll.name}.${r} points to ${targets.join(', ')}, which is not simulated: its links are left null.`);
        d.missing = true;
      }
    }
    // Tags of each language map: those the discovery document uses in filter and sort, plus en and es.
    for (const f of Object.keys(coll.types).filter((x) => coll.types[x] === 'map')) {
      const tags = new Set(['en', 'es']);
      for (const k of [...Object.keys(coll.filter), ...coll.sort.map((s) => s.replace(/^-/, ''))])
        if (k.startsWith(`${f}.`) && TAG.test(k.slice(f.length + 1))) tags.add(k.slice(f.length + 1));
      coll.tags[f] = [...tags];
    }
  }
  // 5.6: an API with localized fields declares its default language; the languages a localized field can be
  // given in are the tags of its language map.
  let defaultLanguage = typeof doc.default_language === 'string' && TAG.test(doc.default_language) ? doc.default_language : null;
  if (Object.values(db).some((c) => Object.keys(c.localized).length) && !defaultLanguage) {
    defaultLanguage = 'en'; served.default_language = 'en';
    warn('Some collections declare localized fields but discovery has no default_language (5.6): served with "en".');
  }
  for (const coll of Object.values(db)) {
    const langs = new Set();
    for (const src of Object.values(coll.localized)) { if (!coll.tags[src].includes(defaultLanguage)) coll.tags[src].push(defaultLanguage); coll.tags[src].forEach((x) => langs.add(x)); }
    coll.langs = [...langs];
  }
  return { db, singletons, served, profiles: active, has, notices, defaultLanguage };
}

// 5.5: what happens after the sunset of a notice the mock knows how to simulate. What is retired stops being declared
// and behaves like what was never declared (unsupported_parameter, 405), except a whole collection or
// singleton, which give 410 retired.
function retire(n, db, singletons, served) {
  const coll = n.scope === 'collection' ? db[n.owner] : null, out = coll ? served.collections[n.owner] : null;
  const drop = (list, v) => { const i = list?.indexOf(v) ?? -1; if (i >= 0) list.splice(i, 1); };
  switch (n.kind) {
    case 'filter': delete coll.filter[n.name]; delete coll.named[n.name]; delete out.filter?.[n.name]; delete out.named_filters?.[n.name]; break;
    case 'operator': if (coll.filter[n.name]) { coll.filter[n.name] = { ...coll.filter[n.name], ops: coll.filter[n.name].ops.filter((o) => o !== n.op) }; out.filter[n.name].ops = coll.filter[n.name].ops; } break;
    case 'sort': drop(coll.sort, n.name); drop(out.sort, n.name); break;
    case 'include': if (coll.relations[n.name]) { coll.relations[n.name].include = false; if (out.relations?.[n.name]) out.relations[n.name].include = false; } break;
    case 'count': if (n.value === 'estimated') { coll.count = coll.count && 'estimated'; if (out.count) out.count = 'estimated'; } else { coll.count = null; delete out.count; } break;
    case 'max_limit': if (Number.isInteger(n.value) && coll.max_limit && n.value < coll.max_limit) { coll.max_limit = n.value; out.max_limit = n.value; } break;
    case 'method': if (n.scope === 'singleton') { drop(singletons[n.owner]?.methods, n.name); drop(served.singletons[n.owner]?.methods, n.name); } else { drop(coll.methods, n.name); drop(out.methods, n.name); } break;
    case 'item_method': drop(coll.item_methods, n.name); drop(out.item_methods, n.name); break;
    case 'action': if (coll.actions[n.name]) coll.actions[n.name].retired = n.sunset; break;
    case 'collection': if (db[n.name]) db[n.name].retired = n.sunset; break;
    case 'singleton': if (singletons[n.name]) singletons[n.name].retired = n.sunset; break;
    default: break;
  }
}

// ── Plausible data generation ─────────────────────────────────────────────────
const FIRST = ['Inés', 'Mikel', 'Lucía', 'Jon', 'Carmen', 'Álvaro', 'Nerea', 'Pablo', 'Ainhoa', 'Diego', 'Marta', 'Iker',
  'Laura', 'Javier', 'Elena', 'Andrés', 'Sara', 'Hugo', 'Paula', 'Daniel', 'Irene', 'Unai', 'Rocío', 'Sergio'];
const LAST = ['Arriaga', 'Etxeberria', 'García', 'López', 'Martín', 'Ruiz', 'Zubizarreta', 'Fernández', 'Sánchez', 'Gómez',
  'Iturbe', 'Navarro', 'Moreno', 'Ortega', 'Bilbao', 'Castro', 'Herrera', 'Uriarte', 'Vidal', 'Molina'];
const CITIES = ['Bilbao', 'Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Zaragoza', 'Donostia', 'Vitoria-Gasteiz', 'Santander',
  'Oviedo', 'Pamplona', 'Granada', 'Salamanca', 'A Coruña', 'Málaga', 'Logroño'];
const STREETS = ['Gran Vía', 'Calle Mayor', 'Calle del Pez', 'Avenida de la Libertad', 'Calle Ercilla', 'Paseo del Prado', 'Calle Licenciado Poza'];
const COMPANIES = ['Marcapáginas', 'Faros del Norte', 'Ferrería', 'Cuaderno Azul', 'Txoko Digital', 'Mareas', 'La Imprenta', 'Ría Software'];
const TITLE_A = ['La niebla de', 'Mareas de', 'Lluvia sobre', 'Cuaderno de', 'Crónica de', 'El silencio de', 'Las cartas de',
  'Un verano en', 'La casa de', 'Los faros de', 'El último ferry a', 'Invierno en'];
const TITLE_B = ['Portugalete', 'Deusto', 'Getxo', 'Abando', 'Mundaka', 'Bermeo', 'Santurtzi', 'Lekeitio', 'Algorta', 'Plentzia',
  'Ondarroa', 'Zorrotza', 'Olabeaga', 'Elantxobe'];
const WORDS = ['ágil', 'claro', 'sencillo', 'práctico', 'resistente', 'ligero', 'cómodo', 'útil', 'robusto', 'discreto'];
const NOUNS = [['Notebook', 'Cuaderno'], ['Pencil', 'Lápiz'], ['Lamp', 'Lámpara'], ['Bag', 'Bolso'], ['Mug', 'Tazón'], ['Map', 'Mapa'],
  ['Clock', 'Reloj'], ['Chair', 'Sillón'], ['Candle', 'Cirio'], ['Bottle', 'Termo'], ['Bookmark', 'Marcapáginas'], ['Folder', 'Archivador']];
const ADJS = [['wooden', 'de madera'], ['travel', 'de viaje'], ['blue', 'azul'], ['green', 'verde'], ['grey', 'gris'], ['paper', 'de papel'],
  ['glass', 'de cristal'], ['small', 'pequeño'], ['large', 'grande'], ['classic', 'clásico']];
const SENTENCES = [['Made by hand in a small workshop.', 'Hecho a mano en un pequeño taller.'],
  ['A favourite of our regular customers.', 'Uno de los favoritos de la clientela habitual.'],
  ['Simple, sturdy and easy to carry.', 'Sencillo, resistente y fácil de llevar.'],
  ['Limited stock: ask before you visit.', 'Existencias limitadas: pregunta antes de venir.']];
const STATUSES = ['active', 'pending', 'archived'];
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ascii = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const pad = (n, w = 2) => String(n).padStart(w, '0');
const decimalOf = (n, places) => (places ? n.toFixed(places) : String(Math.round(n)));

const PEOPLE = /(user|author|speaker|customer|client|people|person|member|employee|staff|contact|writer|student|teacher|usuario|autor|cliente|socio|persona)/;
const PLACES = /(venue|place|room|location|store|shop|office|site|sala|tienda|lugar)/;
const GROUPS = /(categor|tag|genre|topic|section|department)/;
function genString(f, rng, i, s, cname = '') {
  if (Array.isArray(s.enum) && s.enum.length) return rng.pick(s.enum);
  const first = rng.pick(FIRST), last = rng.pick(LAST);
  let v;
  if (/email/.test(f)) v = `${ascii(first)}.${ascii(last)}${i + 1}@example.com`;
  else if (/^(first_name|given_name|nombre)$/.test(f)) v = first;
  else if (/^(last_name|family_name|surname|apellido)/.test(f)) v = `${last} ${rng.pick(LAST)}`;
  else if (/username/.test(f)) v = `${ascii(first)}${ascii(last).slice(0, 3)}${i + 1}`;
  else if (/(^|_)(author|full_name|customer|owner|contact)$/.test(f) || (/^(name|display_name)$/.test(f) && PEOPLE.test(cname)))
    v = `${first} ${last}`;
  else if (/^name$/.test(f) && PLACES.test(cname)) v = `${rng.pick(['Sala', 'Auditorio', 'Espacio', 'Aula'])} ${rng.pick(TITLE_B)}`;
  else if (/^name$/.test(f) && GROUPS.test(cname)) v = `${rng.pick(['Papelería', 'Libros', 'Regalos', 'Música', 'Cómic', 'Viajes', 'Cocina', 'Infantil', 'Arte'])} ${i + 1}`;
  else if (/company|organization|publisher|brand/.test(f)) v = `${rng.pick(COMPANIES)} ${rng.pick(['S.L.', 'S.A.', 'S. Coop.'])}`;
  else if (/title|headline|subject/.test(f)) v = `${rng.pick(TITLE_A)} ${rng.pick(TITLE_B)}`;
  else if (/(description|summary|bio|notes|comment|body|text|content)/.test(f)) v = rng.pick(SENTENCES)[0];
  else if (/(url|website|link|homepage)$/.test(f)) v = `https://example.com/${ascii(rng.pick(TITLE_B))}-${i + 1}`;
  else if (/phone|mobile|tel/.test(f)) v = `+34 6${rng.int(10, 99)} ${rng.int(100, 999)} ${rng.int(100, 999)}`;
  else if (/city|town|ciudad/.test(f)) v = rng.pick(CITIES);
  else if (/address|street/.test(f)) v = `${rng.pick(STREETS)}, ${rng.int(1, 120)}`;
  else if (/postal|zip/.test(f)) v = `${pad(rng.int(1, 52))}${pad(rng.int(0, 999), 3)}`;
  else if (/country/.test(f)) v = rng.pick(['ES', 'PT', 'FR', 'MX', 'AR']);
  else if (/currency/.test(f)) v = 'EUR';
  else if (/(lang|locale)/.test(f)) v = rng.pick(['es', 'en', 'eu', 'ca']);
  else if (/colou?r/.test(f)) v = rng.pick(['rojo', 'azul', 'verde', 'negro', 'blanco']);
  else if (/(sku|code|ref|reference)$/.test(f)) v = `${f.slice(0, 3).toUpperCase()}-${pad(i + 1, 5)}`;
  else if (/isbn/.test(f)) v = `978-84-${rng.int(1000, 9999)}-${rng.int(100, 999)}-${rng.int(0, 9)}`;
  else if (/slug/.test(f)) v = `${ascii(rng.pick(TITLE_B))}-${i + 1}`;
  else if (/status|state/.test(f)) v = rng.pick(STATUSES);
  else if (/(uuid|guid|token)/.test(f)) v = [8, 4, 4, 4, 12].map((n) => Array.from({ length: n }, () => rng.int(0, 15).toString(16)).join('')).join('-');
  else if (/(^|_)(name|label)$/.test(f)) v = `${rng.pick(NOUNS)[1]} ${rng.pick(ADJS)[1]}`;
  else v = `${capital(rng.pick(WORDS))} ${rng.int(1, 999)}`;
  if (Number.isInteger(s.maxLength) && v.length > s.maxLength) v = v.slice(0, s.maxLength);
  if (Number.isInteger(s.minLength) && v.length < s.minLength) v = v.padEnd(s.minLength, 'x');
  return v;
}
function bounds(s, min, max) {
  return [typeof s.minimum === 'number' ? Math.max(min, s.minimum) : min, typeof s.maximum === 'number' ? Math.min(max, s.maximum) : max];
}
function isoDate(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function isoInstant(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
const DAY = 86400000;
function genScalar(coll, f, type, rng, i) {
  const s = coll.constraints[f] ?? {};
  switch (type) {
    case 'enum': return rng.pick(coll.values[f]);
    case 'boolean': return rng.chance(/^(is_)?(active|enabled|available|visible|published)$/.test(f) ? 0.8 : 0.4);
    case 'integer': {
      let [min, max] = /^year$/.test(f) ? [1950, 2026] : /(rating|score|stars)/.test(f) ? [1, 5] : /^age$/.test(f) ? [18, 90] : /(stock|quantity|qty|count)/.test(f) ? [0, 200]
        : /pages/.test(f) ? [48, 900] : /_seconds$/.test(f) ? [30, 7200] : [1, 1000];
      [min, max] = bounds(s, min, max);
      return rng.int(Math.ceil(min), Math.floor(max));
    }
    case 'number': {
      let [min, max] = /(rating|score|stars)/.test(f) ? [1, 5] : /^lat/.test(f) ? [36, 43.7] : /^(lng|lon)/.test(f) ? [-9.3, 3.3] : [0, 1000];
      [min, max] = bounds(s, min, max);
      return Math.round((min + rng() * (max - min)) * 10) / 10;
    }
    case 'decimal': {
      if (/(tax|vat|iva)/.test(f)) return rng.pick(['4', '10', '21']);
      if (/(percent|discount|rate)/.test(f)) return decimalOf(rng.int(0, 50), 0);
      const [min, max] = /(price|cost|fee)/.test(f) ? [1, 120] : /(amount|total|balance|subtotal)/.test(f) ? [5, 2500] : [0, 500];
      return decimalOf(min + rng() * (max - min), 2);
    }
    case 'datetime': {
      const from = Date.UTC(2020, 0, 1), to = Date.UTC(2026, 10, 1);
      const day = from + rng.int(0, Math.floor((to - from) / DAY)) * DAY;
      // Records (created_at…) at any second of the day; appointments, in working hours and on quarter hours.
      let ms = /(created|updated|modified|deleted|seen|logged)/.test(f) ? day + rng.int(0, 86399) * 1000 : day + (rng.int(8 * 4, 21 * 4)) * 900000;
      if (/updated|modified/.test(f) && coll._created) ms = Math.max(ms, coll._created + rng.int(0, 400) * DAY);
      if (/created/.test(f)) coll._created = ms;
      return isoInstant(ms);
    }
    case 'date': {
      const [y0, y1] = /(birth|born)/.test(f) ? [1950, 2006] : [2015, 2026];
      return isoDate(Date.UTC(y0, 0, 1) + rng.int(0, (y1 - y0) * 365) * DAY);
    }
    case 'duration': {
      const forms = [() => `PT${rng.int(5, 180)}M`, () => `PT${rng.int(1, 8)}H${rng.int(0, 59)}M`, () => `P${rng.int(1, 30)}D`, () => `PT${rng.int(30, 3600)}S`];
      return rng.pick(forms)();
    }
    case 'localdatetime': { // 3: a wall-clock date-time without offset, on a quarter hour in working hours
      const day = Date.UTC(2026, 0, 1) + rng.int(0, 700) * DAY + rng.int(8 * 4, 21 * 4) * 900000;
      return isoInstant(day).slice(0, -1);
    }
    case 'object': return sample(s, rng, f);
    case 'timezone': return rng.pick(['Europe/Madrid', 'Atlantic/Canary', 'Europe/Lisbon', 'America/Mexico_City', 'America/Argentina/Buenos_Aires', 'UTC']);
    default: return genString(f, rng, i, s, coll.name);
  }
}
function genMap(coll, f, rng) {
  const noun = rng.pick(NOUNS), adj = rng.pick(ADJS), sentence = rng.pick(SENTENCES);
  const long = /(description|summary|text|body|notes)/.test(f);
  const out = {};
  for (const tag of coll.tags[f]) {
    if (tag !== 'en' && rng.chance(0.3)) continue; // translations are missing on purpose: there is no fallback language (6.1)
    const es = tag === 'es' || tag.startsWith('es-');
    out[tag] = long ? sentence[es ? 1 : 0] : es ? `${noun[1]} ${adj[1]}` : `${capital(adj[0])} ${noun[0].toLowerCase()}`;
  }
  if (rng.chance(0.08)) return {}; // some with no translation at all
  return out;
}
// A link to an item of target in scope key: { id }, with type if the relation goes to several collections
// and with href if target is a subcollection (3: its id only identifies it under its parent).
const linkTo = (target, key, id, poly) => ({ id, ...(poly && { type: target.name }), ...(target.parent && { href: itemPath(target, key, id) }) });
function genRelation(db, coll, f, rng, i, key = '') {
  const d = coll.relations[f];
  if (d.missing) return d.many ? [] : null;
  // The parents of the linking item, and itself: { collection: id }. A link to a subcollection that hangs from
  // one of them stays under the same parent (a book's highlight is a review of that book, not of another).
  const mine = Object.fromEntries([...coll.ancestors, coll.name].map((n, j) => [n, [...(key ? key.split('/') : []), String(i + 1)][j]]));
  const sameParents = (target, k) => { const ids = k ? k.split('/') : []; return target.ancestors.every((n, j) => !(n in mine) || mine[n] === ids[j]); };
  const pickOne = () => {
    const to = [].concat(d.to), name = rng.pick(to), target = db[name];
    // To the same collection (and the same scope) it links only to earlier items, to avoid creating cycles.
    const ids = [...entries(target)].filter(([k, r]) => sameParents(target, k) && (target !== coll || (k === key && Number(r.id) < i + 1)));
    if (!ids.length) return null;
    const [k, r] = rng.pick(ids);
    return linkTo(target, k, r.id, to.length > 1);
  };
  if (d.many) {
    const n = rng.int(0, 3), seen = new Set(), out = [];
    for (let k = 0; k < n; k++) { const o = pickOne(); if (o && !seen.has(o.href ?? o.id)) { seen.add(o.href ?? o.id); out.push(o); } }
    return out;
  }
  const required = coll.required.includes(f);
  if (!required && (rng.chance(0.1) || (db[[].concat(d.to)[0]] === coll && rng.chance(0.4)))) return null;
  return pickOne();
}
// A media type that a media range matches: image/* → image/png.
const concreteType = (range) => (range === '*/*' ? 'application/octet-stream' : !range.endsWith('/*') ? range
  : `${range.slice(0, -2)}/${{ image: 'png', text: 'plain', audio: 'mpeg', video: 'mp4' }[range.slice(0, -2)] ?? 'octet-stream'}`);
function generate(model, seed, counts, defaultCount) {
  const { db } = model;
  // Parents and the collections others depend on first, so that links point to something.
  const order = [], state = {};
  const visit = (name) => {
    if (state[name]) return;
    state[name] = 1;
    if (db[name].parent) visit(db[name].parent);
    // Links to items of a subcollection are filled in at the end (below): that subcollection may
    // hang from this same collection (books → highlight → /books/{book_id}/reviews).
    for (const d of Object.values(db[name].relations)) for (const to of [].concat(d.to)) if (db[to] && to !== name && !d.derived && !db[to].parent) visit(to);
    order.push(name);
  };
  Object.keys(db).forEach(visit);
  const later = []; // [coll, key, row, field, i]: links to subcollections, for when their items exist
  for (const name of order) {
    const coll = db[name];
    // A subcollection: n items under each parent item (3 by default, or --count name=n).
    const n = counts[name] ?? (coll.parent ? Math.min(3, defaultCount) : defaultCount);
    const keys = coll.parent ? [...entries(db[coll.parent])].map(([k, r]) => childKey(k, r.id)) : [''];
    const owns = new Set(Object.values(coll.inherit).map((d) => d.own));
    for (const [f, d] of Object.entries(coll.inherit))
      coll.defaults[f] = d.default ? genScalar(coll, f, coll.types[f], rngFor(seed, name, 'default', f), 0) : undefined;
    for (const key of keys) {
      const rows = scope(coll, key), used = usedOf(coll, key);
      for (let i = 0; i < n; i++) {
        const row = { id: String(i + 1) };
        coll._created = undefined;
        for (const [f, type] of Object.entries(coll.types)) {
          if (f === 'id' || coll.inherit[f] || type === 'localized') continue;
          const rng = key ? rngFor(seed, name, key, i, f) : rngFor(seed, name, i, f);
          if (type === 'map') { row[f] = genMap(coll, f, rng); continue; }
          if (type === 'list') { row[f] = [...new Set(Array.from({ length: rng.int(0, 3) }, () => genScalar(coll, f, coll.lists[f], rng, i)))]; continue; }
          if (type === 'relation') {
            const d = coll.relations[f];
            if (d.derived) continue;
            if ([].concat(d.to).some((to) => db[to]?.parent)) later.push([coll, key, row, f, i]);
            else row[f] = genRelation(db, coll, f, rng, i, key);
            continue;
          }
          if (owns.has(f)) { // an inheritance's own: it almost always inherits, if there is something to inherit from
            const rule = Object.values(coll.inherit).find((d) => d.own === f);
            const canInherit = rule.from.some((r) => coll.relations[r]) || rule.default;
            row[f] = canInherit && rng.chance(0.65) ? null : genScalar(coll, f, type, rng, i);
            continue;
          }
          if (!coll.required.includes(f) && !/^(name|title|email|username)$/.test(f) && rng.chance(0.1)) { row[f] = null; continue; } // some without a value: the null operator has something to find
          row[f] = genScalar(coll, f, type, rng, i);
        }
        // 5.1: an item of a collection with upload carries _content, the link to its bytes.
        if (coll.upload) {
          const rng = rngFor(seed, name, key, i, '_content');
          row._content = { href: `${itemPath(coll, key, row.id)}/content`, media_type: concreteType(coll.upload.media_types[0]),
            size: Math.min(rng.int(200, 4000), coll.upload.max_size ?? Infinity) };
        }
        rows.set(row.id, row);
        used.add(row.id); // 5.1: an id the collection (under that parent) has had is not given again
      }
    }
    coll.nextId = n + 1;
    delete coll._created;
  }
  for (const [coll, key, row, f, i] of later) row[f] = genRelation(db, coll, f, key ? rngFor(seed, coll.name, key, i, f) : rngFor(seed, coll.name, i, f), i, key);
  // 5.9: each singleton is an object with the fields of its schema. One that hangs from an item has one object per
  // parent item, generated when first read.
  for (const sg of Object.values(model.singletons ?? {})) {
    sg.seed = seed;
    sg.row = genSingleton(sg, '');
  }
  refresh(db);
}
function genSingleton(sg, key) {
  const row = {};
  for (const [f, type] of Object.entries(sg.types)) {
    const rng = key ? rngFor(sg.seed, 'singleton', sg.name, key, f) : rngFor(sg.seed, 'singleton', sg.name, f);
    if (!sg.required.includes(f) && sg.nullable[f] && rng.chance(0.1)) { row[f] = null; continue; }
    row[f] = genScalar(sg, f, type, rng, 0);
  }
  return row;
}

// ── Inherited values (11.6), generalized from the reference ───────────────────
// The item a link points to: [collection, row or undefined, scope key]. An item of a
// subcollection is looked up by its href, which has to be the path of an item of that collection with that id.
function targetOf(db, coll, r, link) {
  const d = coll.relations[r];
  if (!d || !isObject(link) || d.missing) return null;
  const to = Array.isArray(d.to) ? (d.to.includes(link.type) ? link.type : null) : d.to;
  const target = to && db[to];
  if (!target) return null;
  if (target.parent) {
    const m = parseHref(db, link.href);
    return m && m.coll === target && m.id === link.id ? [target, m.row, m.key] : [target, undefined, null];
  }
  return [target, target.rows.get(link.id), ''];
}
function source(db, coll, row, f, key = '', seen = new Set()) {
  const rule = coll.inherit[f];
  const self = itemPath(coll, key, row.id);
  // 11.6: while the switch is off, no relationship in from counts as a link.
  const on = !rule.switch || row[rule.switch.field] !== false;
  if (rule.combine === 'fields') {
    // 11.6: each member resolves on its own: the own member, else the linked item's effective member, else the
    // default's. members says where each comes from.
    const fieldsOf = (v) => (isObject(v) ? v : {});
    const own = fieldsOf(row[rule.own]);
    let up = null;
    if (on) for (const r of rule.from) {
      const found = targetOf(db, coll, r, row[r]);
      if (!found) continue;
      const [to, target, tkey] = found;
      if (!target || seen.has(target)) continue;
      seen.add(target);
      up = to.inherit[f]?.combine === 'fields' ? source(db, to, target, f, tkey, seen)
        : { value: target[f], members: Object.fromEntries(Object.keys(fieldsOf(target[f])).map((k) => [k, { href: itemPath(to, tkey, target.id) }])) };
      break;
    }
    const def = rule.default ? fieldsOf(coll.defaults[f]) : {}, above = fieldsOf(up?.value);
    const value = {}, members = {};
    for (const k of new Set([...Object.keys(def), ...Object.keys(above), ...Object.keys(own)])) {
      if (own[k] != null) { value[k] = own[k]; members[k] = { href: self }; }
      else if (above[k] != null) { value[k] = above[k]; members[k] = up.members?.[k] ?? 'default'; }
      else if (def[k] != null) { value[k] = def[k]; members[k] = 'default'; }
    }
    return { value: Object.keys(value).length || row[rule.own] != null ? value : undefined, members, self };
  }
  if (row[rule.own] != null) return { value: row[rule.own], href: self };
  if (on) for (const r of rule.from) {
    const found = targetOf(db, coll, r, row[r]);
    if (!found) continue;
    const [to, target, tkey] = found;
    if (!target || seen.has(target)) continue;
    seen.add(target);
    return to.inherit[f] ? source(db, to, target, f, tkey, seen) : { value: target[f], href: itemPath(to, tkey, target.id) };
  }
  return { value: rule.default ? coll.defaults[f] : undefined };
}
function refresh(db) {
  for (const coll of Object.values(db)) {
    const inherits = Object.keys(coll.inherit).length > 0;
    for (const [key, row] of entries(coll)) {
      const why = {};
      if (inherits) {
        for (const f of [...Object.values(coll.inherit).map((i) => i.own), ...Object.keys(coll.relations).filter((r) => !coll.relations[r].many)]) row[f] ??= null;
        for (const f of Object.keys(coll.inherit)) {
          const s = source(db, coll, row, f, key);
          if (coll.inherit[f].combine === 'fields') {
            // 11.6: _inherited lists the members that do not come from the own object, each with its source.
            if (s.value === undefined) delete row[f]; else row[f] = s.value;
            const inherited = Object.entries(s.members).filter(([, m]) => m === 'default' || m.href !== s.self).map(([k, m]) => [k, { from: m }]);
            if (inherited.length) why[f] = { fields: Object.fromEntries(inherited) };
            continue;
          }
          if (s.value === undefined) delete row[f]; else row[f] = s.value;
          if (row[coll.inherit[f].own] == null) why[f] = { from: s.href ? { href: s.href } : 'default' };
        }
      }
      const all = { ...row };
      for (const k of Object.keys(row)) delete row[k];
      for (const k of Object.keys(coll.types)) if (k in all && coll.types[k] !== 'localized') row[k] = all[k];
      if (all._content) row._content = all._content;
      if (inherits) row._inherited = why;
    }
  }
}

// ── Typed comparison (6.1) ────────────────────────────────────────────────────
// 6.1: the exact value of a JSON number (an operand, or a stored number as JavaScript writes it, 4.3 or 1e+21) as
// a plain decimal string without exponent or trailing zeros: 2e1 and 20.0 are "20". Never through floating point.
function plainDecimal(raw) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(String(raw));
  if (!m) return String(raw);
  let digits = (m[2] + (m[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  const point = (m[2].replace(/^0+/, '').length || -((m[3] ?? '').match(/^0*/)[0].length)) + Number(m[4] ?? 0);
  digits = digits.replace(/0+$/, '') || '0';
  const int = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0');
  const frac = point >= digits.length ? '' : point < 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  return `${m[1] && digits !== '0' ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}
function cmpDecimal(a, b) {
  const neg = (s) => s.startsWith('-') && /[1-9]/.test(s);
  if (neg(a) !== neg(b)) return neg(a) ? -1 : 1;
  const sign = neg(a) ? -1 : 1;
  const [ai, af = ''] = a.replace('-', '').split('.'), [bi, bf = ''] = b.replace('-', '').split('.');
  if (!neg(a) && !neg(b) && !/[1-9]/.test(a + b)) return 0;
  const i1 = ai.replace(/^0+(?=\d)/, ''), i2 = bi.replace(/^0+(?=\d)/, '');
  if (i1.length !== i2.length) return sign * (i1.length - i2.length);
  if (i1 !== i2) return sign * (i1 < i2 ? -1 : 1);
  const n = Math.max(af.length, bf.length), f1 = af.padEnd(n, '0'), f2 = bf.padEnd(n, '0');
  return f1 === f2 ? 0 : sign * (f1 < f2 ? -1 : 1);
}
function cmpText(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
const DATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const LOCALDATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// 3: the duration grammar (RFC 3339, appendix A, plus a fraction of up to nine digits in the seconds). A server
// writes its letters in uppercase and accepts them in lowercase.
const DUR_SEC = '\\d+(?:\\.\\d{1,9})?S';
const DUR_TIME = `T(?:\\d+H(?:\\d+M(?:${DUR_SEC})?)?|\\d+M(?:${DUR_SEC})?|${DUR_SEC})`;
const DURATION = new RegExp(`^P(?:(?:\\d+Y(?:\\d+M(?:\\d+D)?)?|\\d+M(?:\\d+D)?|\\d+D)(?:${DUR_TIME})?|${DUR_TIME}|\\d+W)$`);
const isDuration = (s) => typeof s === 'string' && DURATION.test(s.toUpperCase());
// A valid date-time: a real calendar date and time, without a leap second (6.1 gives invalid_parameter for one).
const timeOk = (s) => { const m = /[Tt](\d{2}):(\d{2}):(\d{2})/.exec(s); return Boolean(m) && Number(m[1]) < 24 && Number(m[2]) < 60 && Number(m[3]) < 60; };
const validDateTime = (s) => DATETIME.test(s) && timeOk(s) && validDate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s.toUpperCase().replace(/\.\d+/, '')));
const validLocal = (s) => LOCALDATETIME.test(s) && timeOk(s) && validDate(s.slice(0, 10));
const TIMEZONE = /^(?:[A-Za-z][A-Za-z0-9_+-]*)(?:\/[A-Za-z0-9_+-]+)*$/;
const validDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
// Instant with nanosecond precision: [milliseconds, fraction below the millisecond].
function instant(s) {
  const frac = /\.(\d+)/.exec(s)?.[1] ?? '';
  return [Date.parse(s.toUpperCase().replace(/\.\d+/, '')) + Number(frac.slice(0, 3).padEnd(3, '0')), Number(frac.slice(3, 9).padEnd(6, '0'))];
}
// 6.1: the length of a duration as an exact decimal number of seconds: a day is 24 hours; years and months, only
// in stored data, count as 365 and 30 days.
function seconds(d) {
  const u = d.toUpperCase();
  if (!DURATION.test(u)) return null;
  const [date, time = ''] = u.slice(1).split('T');
  const part = (src, letter) => BigInt(new RegExp(`(\\d+)${letter}`).exec(src)?.[1] ?? '0');
  const sec = /(\d+)(?:\.(\d+))?S/.exec(time);
  const whole = part(date, 'Y') * 31536000n + part(date, 'M') * 2592000n + part(date, 'W') * 604800n + part(date, 'D') * 86400n
    + part(time, 'H') * 3600n + part(time, 'M') * 60n + BigInt(sec?.[1] ?? '0');
  return sec?.[2] ? `${whole}.${sec[2]}` : String(whole);
}
// 6.1: "server", the mock's collation for the fields that declare it: without case or accents. Equality
// and order agree (equal if neither comes first), and the tie-break by id is done by the order.
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function compare(type, a, b, collation) {
  if (collation && (type === 'string' || type === 'enum')) return cmpText(fold(String(a)), fold(String(b)));
  if (type === 'decimal') return cmpDecimal(String(a), String(b));
  if (type === 'integer' || type === 'number') return cmpDecimal(plainDecimal(a), plainDecimal(b)); // 6.1: exactly
  if (type === 'boolean') return Number(a) - Number(b);
  if (type === 'datetime') { const [x, xn] = instant(a), [y, yn] = instant(b); return x - y || xn - yn; }
  if (type === 'localdatetime') { const [x, xn] = instant(`${a}Z`), [y, yn] = instant(`${b}Z`); return x - y || xn - yn; }
  if (type === 'duration') { const x = seconds(String(a)), y = seconds(String(b)); return x === null || y === null ? 0 : cmpDecimal(x, y); }
  return cmpText(String(a), String(b));
}

// ── JSON Schema validation (4.3), the common part: what action inputs use ─────
// Returns one { pointer, code } entry per failure, with the codes of 5.4. It does not follow $ref or allOf.
const TYPE_OK = {
  object: isObject, array: Array.isArray, string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v), integer: (v) => Number.isInteger(v), null: (v) => v === null,
};
function jsonErrors(s, v, at = '') {
  if (!isObject(s)) return [];
  const alts = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (alts && !alts.some((x) => !jsonErrors(x, v, at).length)) return [{ pointer: at, code: 'type' }];
  if (s.type !== undefined && ![].concat(s.type).some((x) => TYPE_OK[x]?.(v))) return [{ pointer: at, code: v === undefined ? 'required' : 'type' }];
  const out = [];
  if (s.const !== undefined && canonical(s.const) !== canonical(v)) out.push({ pointer: at, code: 'format' });
  if (Array.isArray(s.enum) && !s.enum.some((e) => canonical(e) === canonical(v))) out.push({ pointer: at, code: 'format' });
  if (typeof v === 'number') {
    if ((typeof s.minimum === 'number' && v < s.minimum) || (typeof s.maximum === 'number' && v > s.maximum)
      || (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) || (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum)) out.push({ pointer: at, code: 'range' });
  }
  if (typeof v === 'string') {
    if (Number.isInteger(s.maxLength) && [...v].length > s.maxLength) out.push({ pointer: at, code: 'too_long' });
    if (Number.isInteger(s.minLength) && [...v].length < s.minLength) out.push({ pointer: at, code: 'format' });
    let re = null;
    try { re = typeof s.pattern === 'string' ? new RegExp(s.pattern, 'u') : null; } catch {}
    if (re && !re.test(v)) out.push({ pointer: at, code: 'format' });
    if ((s.format === 'date' && !validDate(v)) || (s.format === 'date-time' && !validDateTime(v)) || (s.format === 'duration' && !isDuration(v)))
      out.push({ pointer: at, code: 'format' });
  }
  if (isObject(v)) {
    for (const k of Array.isArray(s.required) ? s.required : []) if (!(k in v)) out.push({ pointer: `${at}${ptr(k)}`, code: 'required' });
    const props = isObject(s.properties) ? s.properties : {};
    const patterns = Object.keys(isObject(s.patternProperties) ? s.patternProperties : {}).map((p) => { try { return new RegExp(p, 'u'); } catch { return null; } }).filter(Boolean);
    for (const [k, x] of Object.entries(v)) {
      if (Object.hasOwn(props, k)) out.push(...jsonErrors(props[k], x, `${at}${ptr(k)}`));
      else if (s.additionalProperties === false && !patterns.some((re) => re.test(k))) out.push({ pointer: `${at}${ptr(k)}`, code: 'unknown' });
      else if (isObject(s.additionalProperties)) out.push(...jsonErrors(s.additionalProperties, x, `${at}${ptr(k)}`));
    }
  }
  if (Array.isArray(v)) {
    if ((Number.isInteger(s.minItems) && v.length < s.minItems) || (Number.isInteger(s.maxItems) && v.length > s.maxItems)) out.push({ pointer: at, code: 'range' });
    if (isObject(s.items)) v.forEach((x, i) => out.push(...jsonErrors(s.items, x, `${at}/${i}`)));
  }
  return out;
}

// 3: the first member name repeated within one object of a valid JSON text, or null. A scan of its own, since
// JSON.parse keeps only one of them.
function duplicateName(raw) {
  const stack = [];
  let expectKey = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      if (expectKey) {
        const name = JSON.parse(raw.slice(i, j + 1)), names = stack.at(-1);
        if (names.has(name)) return name;
        names.add(name);
        expectKey = false;
      }
      i = j;
    } else if (ch === '{') { stack.push(new Set()); expectKey = true; }
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; }
    else if (ch === ',') expectKey = stack.at(-1) instanceof Set;
  }
  return null;
}

// 11.1: a made-up value that fits a schema (the output of a safe action): the common keywords only.
function sample(s, rng, name = 'value', depth = 0) {
  if (!isObject(s) || depth > 6) return null;
  if (s.const !== undefined) return structuredClone(s.const);
  if (Array.isArray(s.enum) && s.enum.length) return structuredClone(rng.pick(s.enum));
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts) && alts.length) return sample(alts.find((x) => isObject(x) && x.type !== 'null') ?? alts[0], rng, name, depth + 1);
  const type = [].concat(s.type ?? (isObject(s.properties) ? 'object' : s.items ? 'array' : 'string')).find((x) => x !== 'null') ?? 'null';
  const fake = { name, constraints: { [name]: s }, values: {} };
  switch (type) {
    case 'object': return Object.fromEntries(Object.entries(isObject(s.properties) ? s.properties : {}).map(([k, x]) => [k, sample(x, rng, k, depth + 1)]));
    case 'array': return Array.from({ length: Math.max(Number.isInteger(s.minItems) ? s.minItems : 1, 1) }, () => sample(isObject(s.items) ? s.items : {}, rng, name, depth + 1));
    case 'integer': case 'number': case 'boolean': return genScalar(fake, name, type, rng, 0);
    case 'null': return null;
    default: return genScalar(fake, name, s.format === 'date-time' ? 'datetime' : s.format === 'date' ? 'date' : s.format === 'duration' ? 'duration' : 'string', rng, 0);
  }
}

// Deterministic bytes for a generated upload (5.1), whose file nobody sent.
function fakeBytes(size, seedText) {
  const rng = rngFor('bytes', seedText);
  return Buffer.from(Array.from({ length: size }, () => rng.int(0, 255)));
}

// ── The server ────────────────────────────────────────────────────────────────
class Problem extends Error {
  constructor(status, code, detail, extra = {}, headers = {}) { super(text(detail, 'en')); Object.assign(this, { status, code, detail, extra, headers }); }
}
const TITLES = {
  400: t('Bad request', 'Petición incorrecta'), 404: t('Not found', 'No encontrado'), 405: t('Method not allowed', 'Método no permitido'),
  409: t('Conflict', 'Conflicto'), 410: t('Gone', 'Ya no existe'),
  412: t('The resource has changed', 'El recurso ha cambiado'), 413: t('Content too large', 'Contenido demasiado grande'), 415: t('Unsupported media type', 'Tipo de contenido no admitido'),
  422: t('Invalid data', 'Datos no válidos'), 500: t('Internal error', 'Error interno'), 503: t('Service unavailable', 'Servicio no disponible'),
};
const bad = (parameter, detail) => new Problem(400, 'invalid_parameter', detail, { parameter });
const unsupported = (parameter, detail = t(`This resource does not support ${parameter}.`, `Este recurso no admite ${parameter}.`)) =>
  new Problem(400, 'unsupported_parameter', detail, { parameter });
const invalid = (errors, detail = t('Invalid data.', 'Datos no válidos.')) => new Problem(422, 'invalid', detail, { errors });
const once = (key) => bad(key, t(`Send ${key} once.`, `Envía ${key} una sola vez.`));
const RESERVED = ['filter', 'sort', 'fields', 'include', 'count', 'limit', 'cursor', 'since', 'languages'];
const reservedName = (k) => k.replace(/\[.*$/, '');
const isReserved = (base) => RESERVED.includes(base) || base.startsWith('$');
const PAGE_ONLY = ['cursor', 'limit', 'fields', 'include', 'count'];
const tags = (header) => (header ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const strongMatch = (header, tag) => tags(header).some((x) => x === '*' || (!x.startsWith('W/') && x === tag));
const weakMatch = (header, tag) => tags(header).some((x) => x === '*' || x.replace(/^W\//, '') === tag);
const TTL = 24 * 3600 * 1000;
// 8: cache groups (RFC 9875) as a list of Structured Fields strings; the collection first.
const groups = (paths) => [...new Set(paths)].slice(0, 32).map((g) => `"${g.replace(/[\\"]/g, '\\$&')}"`).join(', ');

export function createMock(model, options = {}) {
  const { db, served, profiles, has } = model;
  // 8: Cache-Groups and Cache-Group-Invalidation belong to the cache profile; without it they are not sent.
  const cacheGroups = (name, paths) => (has('cache') ? { [name]: groups(paths) } : {});
  const link = `<${PROFILE}>; rel="profile"`; // 4.1: a single link, to the version URI
  const seed = options.seed ?? 1;
  const cursorKey = createHash('sha256').update(`restep-mock cursor ${seed}`).digest();
  const sign = (s) => createHmac('sha256', cursorKey).update(s).digest('base64url').slice(0, 22);
  const idempotency = new Map();
  const status = typeof served.status === 'string' && served.status.startsWith('/') ? served.status : null;
  const schemaPaths = options.linked ?? {};

  function send(res, code, data, headers = {}, head = false) {
    const body = data === undefined ? '' : JSON.stringify(data);
    const type = code >= 400 ? 'application/problem+json' : 'application/json';
    res.writeHead(code, { Link: link, ...(body && { 'Content-Type': type }), ...headers });
    res.end(head ? undefined : body);
  }
  function problem(res, p, req) {
    const lang = pickLanguage(req.headers['accept-language']);
    const extra = p.extra.errors ? { ...p.extra, errors: p.extra.errors.map((e) => ({ ...e, detail: text(e.detail, lang) })) } : p.extra;
    send(res, p.status, {
      type: `${PROFILE}errors#${p.code}`, title: text(TITLES[p.status] ?? 'Error', lang), status: p.status,
      code: p.code, detail: text(p.detail, lang), ...extra,
    }, { 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...req.extra, ...p.headers }, req.method === 'HEAD');
  }

  // Dotted path: a translation (name.es-mx), a field of a relation (author.id, author.name).
  // 3: a localized field is the text of its language map in the language of the response (or null).
  function at(coll, row, f, lang) {
    if (row == null) return undefined;
    if (coll.localized?.[f]) return row[coll.localized[f]]?.[lang] ?? null;
    const dot = f.indexOf('.');
    if (dot < 0) return row[f];
    const head = f.slice(0, dot), rest = f.slice(dot + 1);
    if (coll.types[head] === 'map') return row[head]?.[rest];
    if (coll.types[head] === 'relation') {
      const v = row[head];
      if (!isObject(v)) return undefined;
      if (rest === 'id' || rest === 'type') return v[rest];
      const found = targetOf(db, coll, head, v);
      return found && found[1] ? at(found[0], found[1], rest, lang) : undefined;
    }
    // 6.1: a field inside an object of the item (address.city).
    if (isObject(row[head])) return rest.split('.').reduce((o, k) => (isObject(o) ? o[k] : undefined), row[head]);
    return undefined;
  }
  // The collection a relation leads to, if only one.
  const relatedColl = (coll, r) => { const d = coll.relations[r]; return d && !d.missing && !Array.isArray(d.to) ? db[d.to] : null; };
  // 6.1: the related items of a to-many relation, as rows: the subcollection's under the item, or the linked ones.
  function related(coll, row, r) {
    const d = coll.relations[r];
    if (!d || d.missing) return [];
    if (d.derived) { const sub = db[d.derived]; return [...(sub?.scopes.get(childKey(coll.key ?? '', row.id))?.values() ?? [])]; }
    return [].concat(row[r] ?? []).map((link) => targetOf(db, coll, r, link)?.[1]).filter(Boolean);
  }
  function typeOf(coll, f) {
    const d = coll.filter[f];
    if (d?.type) return d.type === 'enum' ? (d.values ?? coll.values[f]) : d.type;
    if (f.includes('.')) {
      const [head, ...rest] = f.split('.');
      if (coll.types[head] === 'map' || rest[0] === 'id') return 'string';
      const found = coll.relations[head] && !coll.relations[head].missing && db[[].concat(coll.relations[head].to)[0]];
      return found ? typeOf(found, rest.join('.')) : 'string';
    }
    if (coll.types[f] === 'list') return coll.lists[f] === 'enum' ? coll.values[f] : coll.lists[f];
    if (coll.types[f] === 'localized') return 'string';
    return coll.types[f] === 'enum' ? coll.values[f] : coll.types[f] ?? 'string';
  }
  function parseValue(type, raw, key) {
    const withinLimit = (x) => {
      if (numberOverLimit(x)) throw bad(key, t(`A numeric operand is 0 or has a magnitude from 1e-${NUMBER_LIMIT} to 1e${NUMBER_LIMIT}, this server's limit.`,
        `Un operando numérico es 0 o tiene una magnitud de 1e-${NUMBER_LIMIT} a 1e${NUMBER_LIMIT}, el límite de este servidor.`));
      return plainDecimal(x); // 6.1: its exact value, never a floating-point number
    };
    const fail = (what) => { throw bad(key, t(`${raw} is not a valid ${what}.`, `${raw} no es un ${what} válido.`)); };
    if (Array.isArray(type)) {
      if (type.includes(raw)) return raw;
      throw bad(key, t(`${raw} is not one of: ${type.join(', ')}.`, `${raw} no es ninguno de: ${type.join(', ')}.`));
    }
    switch (type) {
      case 'decimal': return DECIMAL.test(raw) ? raw : fail('decimal');
      case 'integer': return integerLiteral(raw) ? withinLimit(raw) : fail('integer'); // 6.1: 20.0 is 20
      case 'number': return JSON_NUMBER.test(raw) ? withinLimit(raw) : fail('number');
      case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : fail('boolean (true or false)');
      case 'date': return validDate(raw) ? raw : fail('date (YYYY-MM-DD)');
      case 'datetime': return validDateTime(raw) ? raw : fail('RFC 3339 date-time with offset');
      case 'localdatetime': return validLocal(raw) ? raw.toUpperCase() : fail('local date-time (YYYY-MM-DDTHH:MM:SS)');
      case 'timezone': return TIMEZONE.test(raw) ? raw : fail('time zone name');
      case 'duration': {
        if (!isDuration(raw)) fail('duration (3)');
        if (/[YM]/.test(raw.toUpperCase().split('T')[0])) throw bad(key, t('Years and months have no fixed length: use days, hours, minutes or seconds.',
          'Los años y los meses no tienen una longitud fija: usa días, horas, minutos o segundos.'));
        return raw;
      }
      default: return raw;
    }
  }
  const MAX_IN = 500;
  const OPS = { eq: (c) => c === 0, ne: (c) => c !== 0, lt: (c) => c < 0, le: (c) => c <= 0, gt: (c) => c > 0, ge: (c) => c >= 0 };
  const SAME_FILTER = t('The same filter appears twice.', 'El mismo filtro aparece dos veces.');
  function applyFilters(coll, params, lang) {
    let items = [...coll.rows.values()];
    const seen = new Set(), present = new Set();
    const groups = new Map(); // 6.1: filters through the same to-many relation, or on the same list field
    for (const [key, value] of params) {
      if (reservedName(key) !== 'filter') continue;
      if (key === 'filter') throw unsupported(key, t('filter as an expression needs the filter-expr extension.', 'filter como expresión necesita la extensión filter-expr.'));
      const m = key.match(/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/);
      if (!m) throw unsupported(key, t('This resource supports filter[field] and filter[field][op].', 'Este recurso admite filter[campo] y filter[campo][op].'));
      const [, field, op = 'eq'] = m;
      present.add(field);
      if (Object.hasOwn(coll.named, field)) {
        const n = coll.named[field];
        if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));
        // 6.1: false turns a default switch off; on any other switch, any value gives invalid_parameter.
        if (!n.type && n.default && value === 'false') continue;
        if (!n.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));
        if (n.type && value === '') throw bad(key, t(`${field} needs a ${n.type} value.`, `${field} necesita un valor ${n.type}.`));
        if (n.type) parseValue(n.type === 'enum' ? n.values ?? [] : n.type, value, key);
        if (!n.type && n.default) continue; // applied below, as when it is left out
        items = items.filter((r) => named(field, value, r));
        continue;
      }
      if (!Object.hasOwn(coll.filter, field)) throw unsupported(key, t(`${field} cannot be filtered. Filterable: ${Object.keys(coll.filter).join(', ') || 'none'}.`, `${field} no se puede filtrar. Se puede por: ${Object.keys(coll.filter).join(', ') || 'ninguno'}.`));
      if (!coll.filter[field].ops.includes(op)) throw unsupported(key, t(`${field} supports: ${coll.filter[field].ops.join(', ')}.`, `${field} admite: ${coll.filter[field].ops.join(', ')}.`));
      if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);
      seen.add(`${field}[${op}]`);
      const d = coll.filter[field];
      const head = field.split('.')[0];
      const grouped = d.quantifier === 'some' || (op === 'null' && !field.includes('.') && (coll.types[field] === 'list' || coll.relations[field]?.many));
      if (grouped) {
        // 6.1: in a group, a path through the relation is read on each related item; a list field, on each element.
        const g = groups.get(head) ?? { tests: [], none: null };
        groups.set(head, g);
        // 6.1: null with a quantifier tests the whole relation or list (the group), never each element.
        if (op === 'null') {
          if (value !== 'true' && value !== 'false') throw bad(key, t('Use true or false.', 'Usa true o false.'));
          // 6.1: more than one null filter on the same to-many relationship or list field, its own or that of a
          // path through it, gives invalid_parameter, even when their values agree.
          if (g.none !== null) throw bad(key, t(`Only one null filter on ${head}, its own or that of a path through it.`, `Solo un filtro null sobre ${head}, el suyo o el de una ruta que pase por él.`));
          g.none = value === 'true';
          continue;
        }
        const rest = field.includes('.') ? field.slice(head.length + 1) : null;
        const target = rest ? relatedColl(coll, head) : null;
        g.tests.push(predicate(op, value, key, typeOf(coll, field), coll.collations[field], (x) => (rest ? (target ? at(target, x, rest, lang) : undefined) : x)));
        continue;
      }
      items = items.filter(predicate(op, value, key, typeOf(coll, field), coll.collations[field], (r) => at(coll, r, field, lang)));
    }
    // 6.1: some related item, or element, that matches every filter of the group; null=true alone asks for none
    // (empty, absent or null), and together with other filters negates the group: true is "no visible element
    // matches all the other filters of the group at once", false "some does".
    for (const [head, g] of groups) {
      items = items.filter((r) => {
        const xs = coll.types[head] === 'list' ? [].concat(r[head] ?? []) : related(coll, r, head);
        if (!g.tests.length) return g.none === null ? true : g.none === !xs.length;
        const some = xs.some((x) => g.tests.every((test) => test(x)));
        return g.none === true ? !some : some;
      });
    }
    // 6.1: a default switch applies unless turned off; a required filter must be there.
    for (const [f, n] of Object.entries(coll.named)) if (n.default && !params.getAll(`filter[${f}]`).includes('false')) items = items.filter((r) => named(f, '', r));
    for (const [f, d] of [...Object.entries(coll.filter), ...Object.entries(coll.named)])
      if (d.required && !present.has(f)) throw bad(`filter[${f}]`, t(`filter[${f}] is required in a list request.`, `filter[${f}] es obligatorio al listar.`));
    return items;
  }
  // A named filter's meaning is only in its description: the mock picks, deterministically, part of the items.
  const named = (f, value, r) => parseInt(hash(`${f}=${value}:${r.id}`).slice(0, 8), 16) % 2 === 0;
  // The test of one filter on a value read with get. 6.1: every operator but null never matches an absent value.
  function predicate(op, value, key, type, collation, get) {
    const ty = Array.isArray(type) ? 'enum' : type;
    if (op === 'null') {
      if (value !== 'true' && value !== 'false') throw bad(key, t('Use true or false.', 'Usa true o false.'));
      return (r) => (get(r) == null) === (value === 'true');
    }
    if (op === 'in' || op === 'nin') {
      // 6.1: filter[f][in]= is an empty list, which gives invalid_parameter; an empty element between commas is
      // the empty string.
      if (value === '') throw bad(key, t(`${op} needs a non-empty, comma-separated list.`, `${op} necesita una lista no vacía, separada por comas.`));
      const values = value.split(',');
      // 5.3: a limit that is not declared; passing it gives invalid_parameter, never part of the result.
      if (values.length > MAX_IN) throw bad(key, t(`${op} takes at most ${MAX_IN} values.`, `${op} admite como mucho ${MAX_IN} valores.`));
      const parsed = values.map((v) => parseValue(type, v, key));
      return (r) => get(r) != null && parsed.some((v) => compare(ty, get(r), v, collation) === 0) === (op === 'in');
    }
    if (op === 'prefix' || op === 'contains') {
      if (value === '') throw bad(key, t(`${op} needs a non-empty operand.`, `${op} necesita un operando no vacío.`));
      const norm = (x) => (collation ? fold(String(x)) : String(x));
      const needle = norm(value);
      return (r) => get(r) != null && (op === 'prefix' ? norm(get(r)).startsWith(needle) : norm(get(r)).includes(needle));
    }
    const v = parseValue(type, value, key);
    return (r) => get(r) != null && OPS[op](compare(ty, get(r), v, collation));
  }
  function parseSort(coll, params) {
    if (params.getAll('sort').length > 1) throw once('sort');
    if (!params.has('sort')) return [];
    const sort = params.get('sort').split(',');
    for (const s of sort) {
      const f = s.replace(/^-/, '');
      if (!f) throw bad('sort', t('Empty sort key.', 'Clave de orden vacía.'));
      if (!coll.sort.includes(f)) throw unsupported('sort', coll.sort.length ? t(`${f} is not sortable. Sortable: ${coll.sort.join(', ')}.`, `${f} no se puede ordenar. Se puede por: ${coll.sort.join(', ')}.`)
        : t('This collection declares no sort.', 'Esta colección no declara sort.'));
    }
    return sort;
  }
  // include (9): rutas de relaciones expandibles, hasta include_depth.
  function parseInclude(coll, params) {
    if (params.getAll('include').length > 1) throw once('include');
    const raw = params.get('include');
    if (raw === null) return [];
    const paths = raw.split(',');
    for (const p of paths) {
      if (!p) throw bad('include', t('Empty include path.', 'Ruta de include vacía.'));
      const segs = p.split('.');
      if (segs.length > coll.includeDepth) throw unsupported('include', t(`include goes ${coll.includeDepth} level(s) deep at most.`, `include llega como mucho a ${coll.includeDepth} nivel(es).`));
      let c = coll;
      for (const s of segs) {
        const d = c?.relations[s];
        if (!d || !d.include || d.missing) throw unsupported('include', t(`${s} is not an includable relation.`, `${s} no es una relación que se pueda incluir.`));
        c = Array.isArray(d.to) ? null : db[d.to];
      }
    }
    return paths;
  }
  function expand(coll, row, paths, lang) {
    if (!paths.length) return row;
    const out = { ...row };
    const byRel = {};
    for (const p of paths) { const [h, ...rest] = p.split('.'); (byRel[h] ??= []).push(...(rest.length ? [rest.join('.')] : [])); }
    for (const [r, sub] of Object.entries(byRel)) {
      const one = (link) => {
        const found = targetOf(db, coll, r, link);
        if (!found || !found[1]) return link;
        const tc = found[0].parent ? view(found[0], found[2]) : found[0];
        const full = present(tc, expand(tc, found[1], sub, lang), lang);
        return isObject(link) && (link.type || link.href) ? { ...full, ...(link.type && { type: link.type }), ...(link.href && { href: link.href }) } : full;
      };
      if (coll.relations[r]?.derived) out[r] = children(coll, row, r).map(one);
      else if (Array.isArray(row[r])) out[r] = row[r].map(one);
      else if (row[r] != null) out[r] = one(row[r]);
    }
    return out;
  }
  function parseFields(params, coll, include = []) {
    if (params.getAll('fields').length > 1) throw once('fields');
    const raw = params.get('fields');
    if (raw === null) return null;
    const fields = raw.split(',');
    for (const f of fields) {
      const head = f.split('.')[0];
      if (f.includes('.') && coll.types[head] === 'map')
        throw bad('fields', t(`${head} is a language map: ask for it whole.`, `${head} es un mapa de idioma: pídelo entero.`));
      if (f.includes('.')) {
        if (!has('relations')) throw unsupported('fields', t('Dotted paths in fields need the relations profile.', 'Las rutas con punto en fields necesitan el perfil relations.'));
        const rel = f.slice(0, f.lastIndexOf('.'));
        if (!include.includes(rel)) throw bad('fields', t(`${f} needs include=${rel}.`, `${f} necesita include=${rel}.`));
        // 6.3: the field of the included item has to exist (if the relation goes to a single collection).
        let c = coll;
        for (const seg of rel.split('.')) { const d = c?.relations[seg]; c = d && !Array.isArray(d.to) ? db[d.to] : null; }
        const last = f.slice(f.lastIndexOf('.') + 1);
        if (c && !Object.hasOwn(c.types, last)) throw bad('fields', t(`${rel} has no field ${last}.`, `${rel} no tiene ningún campo ${last}.`));
        continue;
      }
      if (!Object.hasOwn(coll.types, f)) throw bad('fields', t(`There is no field ${f || '(empty)'}.`, `No hay ningún campo ${f || '(vacío)'}.`));
    }
    return fields;
  }
  function pick(row, fields) {
    if (!fields) return row;
    const out = { id: row.id };
    const nested = {};
    for (const f of fields) {
      const dot = f.indexOf('.');
      if (dot < 0) { if (f in row) out[f] = row[f]; continue; }
      (nested[f.slice(0, dot)] ??= []).push(f.slice(dot + 1));
    }
    for (const [r, sub] of Object.entries(nested)) {
      const v = row[r];
      const one = (o) => (isObject(o) ? { ...pick(o, sub), ...(o.type && { type: o.type }), ...(o.href && { href: o.href }) } : o);
      out[r] = Array.isArray(v) ? v.map(one) : one(v);
    }
    const why = isObject(row._inherited) ? Object.entries(row._inherited).filter(([f]) => f in out) : [];
    if (why.length) out._inherited = Object.fromEntries(why);
    return out;
  }
  // 6.1 and 6.4: operands equal under the field's type are the same filter, also for the cursor: a numeric
  // operand is bound by its exact value (20, 20.0 and 2e1 alike).
  const sameOperands = (coll, params) => new URLSearchParams([...params].map(([k, v]) => {
    const m = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(k);
    const type = m && Object.hasOwn(coll.filter, m[1]) && m[2] !== 'null' ? typeOf(coll, m[1]) : null;
    return ['integer', 'number', 'decimal'].includes(type) ? [k, v.split(',').map((x) => exactNumber(x) ?? x).join(',')] : [k, v];
  }));
  const queryPrint = (path, params) => hash(`${path}?${new URLSearchParams([...params].filter(([k]) => !PAGE_ONLY.includes(k)).sort())}`);
  const makeCursor = (o, print) => { const payload = Buffer.from(JSON.stringify({ o, q: print })).toString('base64url'); return `${payload}.${sign(payload)}`; };
  function readCursor(params, print) {
    if (!params.has('cursor')) return 0;
    let c = {};
    const parts = params.get('cursor').split('.');
    const [payload, mac] = parts;
    if (parts.length === 2 && mac === sign(payload)) { try { c = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch {} }
    if (!Number.isInteger(c.o) || c.o < 0 || c.q !== print) throw bad('cursor', t('Invalid or expired cursor, or one issued for another query.', 'Cursor no válido o caducado, o emitido para otra consulta.'));
    return c.o;
  }
  // 6.2: a sort key; a to-many path declared with quantifier sorts by the least related value ascending and by
  // the greatest descending.
  function sortValue(coll, row, f, desc, lang) {
    if (coll.filter[f]?.quantifier !== 'some') return at(coll, row, f, lang);
    const head = f.split('.')[0], rest = f.slice(head.length + 1);
    const target = rest ? relatedColl(coll, head) : null;
    const xs = (coll.types[head] === 'list' ? [].concat(row[head] ?? []) : related(coll, row, head).map((x) => (target ? at(target, x, rest, lang) : undefined))).filter((x) => x != null);
    if (!xs.length) return undefined;
    const ty = typeOf(coll, f), cmp = (x, y) => compare(Array.isArray(ty) ? 'enum' : ty, x, y, coll.collations[f]);
    return xs.reduce((m, x) => ((desc ? cmp(x, m) > 0 : cmp(x, m) < 0) ? x : m));
  }
  function list(coll, params, path, lang) {
    let items = applyFilters(coll, params, lang);
    const sort = parseSort(coll, params);
    items.sort((a, b) => {
      for (const s of [...sort, 'id']) {
        const f = s.replace(/^-/, '');
        const x = sortValue(coll, a, f, s.startsWith('-'), lang), y = sortValue(coll, b, f, s.startsWith('-'), lang);
        if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? 1 : -1; }
        const ty = typeOf(coll, f);
        const d = compare(Array.isArray(ty) ? 'enum' : ty, x, y, coll.collations[f]) * (s.startsWith('-') ? -1 : 1);
        if (d) return d;
      }
      return 0;
    });
    if (params.getAll('limit').length > 1) throw once('limit');
    const limit = params.has('limit') ? Number(params.get('limit')) : Math.min(20, coll.max_limit ?? 20);
    if (params.has('limit') && (!/^\d+$/.test(params.get('limit')) || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit))
      throw bad('limit', t(`Between 1 and ${coll.max_limit}.`, `Entre 1 y ${coll.max_limit}.`));
    // 6.4: the cursor is bound to the query and, with localized fields, to the language.
    const print = queryPrint(coll.langs?.length ? `${path}#${lang}` : path, sameOperands(coll, params));
    const offset = readCursor(params, print);
    const count = params.get('count');
    if (count !== null && !coll.count) throw unsupported('count'); // 6.5: with any value, false included
    if (count !== null && count !== 'true' && count !== 'false') throw bad('count', t('Use true or false.', 'Usa true o false.'));
    const include = has('relations') ? parseInclude(coll, params) : [];
    const fields = parseFields(params, coll, include);
    const page = items.slice(offset, offset + limit);
    const writable = coll.item_methods.includes('PATCH') || coll.item_methods.includes('DELETE');
    let next = null;
    if (offset + limit < items.length) {
      const q = new URLSearchParams(params);
      q.set('cursor', makeCursor(offset + limit, print));
      next = `${path}?${q}`;
    }
    // "estimated" count: rounded to the ten, as a server that estimates would.
    const total = coll.count === 'estimated' ? Math.round(items.length / 10) * 10 : items.length;
    return {
      // 7.2: an item that allows PATCH or DELETE carries in _etag the ETag of its GET (of the whole row).
      items: page.map((r) => (writable ? { ...pick(present(coll, expand(coll, r, include, lang), lang), fields), _etag: tagOf(coll, r, lang) }
        : pick(present(coll, expand(coll, r, include, lang), lang), fields))), next,
      ...(count === 'true' && { total }),
      ...(count === 'true' && coll.count === 'estimated' && { total_estimated: true }),
    };
  }

  // 3: the representation of an item: its stored row and its localized fields in the language of the response.
  function present(coll, row, lang) {
    const names = Object.keys(coll.localized ?? {});
    if (!names.length || row == null) return row;
    return { ...row, ...Object.fromEntries(names.map((f) => [f, at(coll, row, f, lang)])) };
  }
  // 5.6 and 7.2: each language is a different representation, so with localized fields the item ETag differs by
  // language; If-Match succeeds with the one of any language.
  const localizes = (coll) => Object.keys(coll.localized ?? {}).length > 0;
  const tagOf = (coll, row, lang) => {
    const value = localizes(coll) ? [lang, row] : row;
    const n = coll.incarnations?.get(childKey(coll.key ?? '', row.id));
    return etag(n ? [n, value] : value);
  };
  const matchesItem = (header, coll, row) => (localizes(coll) ? coll.langs.some((l) => strongMatch(header, tagOf(coll, row, l))) : strongMatch(header, tagOf(coll, row)));
  const languageHeaders = (coll, lang) => (localizes(coll) ? { Vary: 'Accept-Language', 'Content-Language': lang } : {});

  // ── Writes ──
  // 3: the media type is compared case-insensitively; charset can only be utf-8 (quoted or not) and the
  // other parameters are ignored. A body without Content-Type, even an empty one, gives 415.
  function mediaTypeOk(header, types) {
    if (header === undefined) return false;
    const [type, ...params] = header.split(';');
    if (!types.includes(type.trim().toLowerCase())) return false;
    for (const p of params) {
      const eq = p.indexOf('=');
      if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
      let value = p.slice(eq + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      if (value.toLowerCase() !== 'utf-8') return false;
    }
    return true;
  }
  async function readJson(req, types) {
    if (!mediaTypeOk(req.headers['content-type'], types))
      throw new Problem(415, 'unsupported_media_type', t(`Send ${types.join(' or ')}, in UTF-8.`, `Envía ${types.join(' o ')}, en UTF-8.`), {},
        types.includes('application/merge-patch+json') ? { 'Accept-Patch': 'application/merge-patch+json' } : {});
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return parseBody(raw);
  }
  // 3: a body that is not JSON gives 400. 5.1 and 4.3: a JSON value that is not an object is kept; it gives 422 with
  // objectBody(), after the preconditions (5.4).
  function parseBody(raw) {
    let v;
    try { v = JSON.parse(raw); } catch {
      throw new Problem(400, 'bad_request', t('The body is not valid JSON.', 'El cuerpo no es JSON válido.'));
    }
    // 3: a body with duplicate member names SHOULD give 400 (JSON.parse would silently keep the last one).
    const dup = duplicateName(raw);
    if (dup !== null) throw new Problem(400, 'bad_request', t(`The body repeats the member name ${JSON.stringify(dup)} in an object.`, `El cuerpo repite el nombre ${JSON.stringify(dup)} en un objeto.`));
    if (!isObject(v)) return [v, v];
    return [Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_'))), v];
  }
  // 5.1 and 4.3: a body that is a JSON value but not an object gives 422 invalid, with a type entry at "".
  // 3: then an unpaired surrogate or a noncharacter, which the mock rejects (3 allows it), gives 422 invalid with
  // a format entry whose pointer is the string that holds it, or "" when that string is a member name (a pointer to
  // it would have to contain the same code point). Both come after the
  // preconditions (5.4); a body that is not JSON already got 400 bad_request, whatever else it holds.
  function objectBody(v) {
    if (!isObject(v)) throw invalid([{ pointer: '', code: 'type', detail: t('The body must be a JSON object.', 'El cuerpo tiene que ser un objeto JSON.') }]);
    const bad = badCharacters(v);
    if (bad.length) throw invalid(bad);
    return v;
  }
  function badCharacters(v, at = '') {
    const bad = (s) => { for (const ch of s) { const cp = ch.codePointAt(0);
      if ((cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return true; } return false; };
    const entry = (pointer) => ({ pointer, code: 'format', detail: t('An unpaired surrogate or a noncharacter.', 'Un sustituto suelto o un no carácter.') });
    if (typeof v === 'string') return bad(v) ? [entry(at)] : [];
    if (Array.isArray(v)) return v.flatMap((x, i) => badCharacters(x, `${at}/${i}`));
    if (isObject(v)) return Object.entries(v).flatMap(([k, x]) => (bad(k) ? [entry('')] : badCharacters(x, at + ptr(k))));
    return [];
  }
  // 7.1: the fingerprint's query as [name, [values]], sorted by name (the order of distinct names does not
  // count) and with the values of each name in the order received (that one does).
  function idempotencyQuery(params) {
    const byName = new Map();
    for (const [k, v] of params) byName.set(k, [...(byName.get(k) ?? []), v]);
    return [...byName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  function mergePatch(target, patch) {
    if (!isObject(patch)) return patch;
    const out = isObject(target) ? { ...target } : {};
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = mergePatch(out[k], v); }
    return out;
  }
  function scalarOk(type, v) {
    switch (type) {
      case 'decimal': return typeof v === 'string' && DECIMAL.test(v);
      case 'integer': return Number.isInteger(v);
      case 'number': return typeof v === 'number' && Number.isFinite(v);
      case 'boolean': return typeof v === 'boolean';
      default: return typeof v === 'string';
    }
  }
  function formatOk(type, v) {
    if (type === 'date') return validDate(v);
    if (type === 'datetime') return validDateTime(v);
    if (type === 'localdatetime') return validLocal(v);
    if (type === 'timezone') return TIMEZONE.test(v);
    if (type === 'duration') return isDuration(v);
    return true;
  }
  function validate(coll, row, label, errors = []) {
    for (const f of coll.required) if (row[f] === undefined || row[f] === null) errors.push({ pointer: ptr(f), code: 'required', detail: t(`${f} is required.`, `${f} es obligatorio.`) });
    for (const [f, v] of Object.entries(row)) {
      if (f.startsWith('_')) continue;
      if (!Object.hasOwn(coll.types, f)) { errors.push({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) }); continue; }
      const type = coll.types[f];
      if (v === null || f === 'id' || type === 'map' || type === 'relation' || type === 'localized') continue;
      if (type === 'object') { // 11.6: an object, against its schema
        const found = isObject(v) ? jsonErrors(coll.constraints[f] ?? {}, v, ptr(f)) : [{ pointer: ptr(f), code: 'type' }];
        for (const e of found) errors.push({ ...e, detail: t(`${e.pointer} does not fit the schema of ${f} (${e.code}).`, `${e.pointer} no encaja con el esquema de ${f} (${e.code}).`) });
        continue;
      }
      if (type === 'list') { // 6.1: a list of scalars of its element type
        const el = coll.lists[f];
        if (!Array.isArray(v) || !v.every((x) => scalarOk(el, x) && (el !== 'enum' || coll.values[f].includes(x))))
          errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be a list of ${el} values.`, `${f} tiene que ser una lista de valores ${el}.`) });
        // 3: an element of the right type but not of its format (an instant with a leap second, :60) gets format.
        else for (const [i, x] of v.entries()) if (!formatOk(el, x))
          errors.push({ pointer: `${ptr(f)}/${i}`, code: 'format', detail: t(`${f}/${i} is not a valid ${el}.`, `${f}/${i} no es un ${el} válido.`) });
        continue;
      }
      if (!scalarOk(type, v)) {
        errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be a ${type}${type === 'decimal' ? ' in a string, such as "18.50"' : ''}.`,
          `${f} tiene que ser de tipo ${type}${type === 'decimal' ? ' en una cadena, como "18.50"' : ''}.`) });
        continue;
      }
      if (type === 'enum' && !coll.values[f].includes(v)) {
        errors.push({ pointer: ptr(f), code: 'format', detail: t(`${f} must be one of: ${coll.values[f].join(', ')}.`, `${f} tiene que ser uno de: ${coll.values[f].join(', ')}.`) });
        continue;
      }
      if (!formatOk(type, v)) { errors.push({ pointer: ptr(f), code: 'format', detail: t(`${f} is not a valid ${type}.`, `${f} no es un ${type} válido.`) }); continue; }
      // Constraints of the declared schema (4.3), the most common ones.
      const s = coll.constraints[f] ?? {};
      if (typeof v === 'number' && ((typeof s.minimum === 'number' && v < s.minimum) || (typeof s.maximum === 'number' && v > s.maximum)))
        errors.push({ pointer: ptr(f), code: 'range', detail: t(`${f} is out of range.`, `${f} está fuera de rango.`) });
      if (typeof v === 'string' && Number.isInteger(s.maxLength) && [...v].length > s.maxLength)
        errors.push({ pointer: ptr(f), code: 'too_long', detail: t(`${f} has more than ${s.maxLength} characters.`, `${f} tiene más de ${s.maxLength} caracteres.`) });
      if (typeof v === 'string' && Number.isInteger(s.minLength) && [...v].length < s.minLength)
        errors.push({ pointer: ptr(f), code: 'format', detail: t(`${f} needs at least ${s.minLength} characters.`, `${f} necesita al menos ${s.minLength} caracteres.`) });
      if (typeof v === 'string' && Array.isArray(s.enum) && !s.enum.includes(v))
        errors.push({ pointer: ptr(f), code: 'format', detail: t(`${f} must be one of: ${s.enum.join(', ')}.`, `${f} tiene que ser uno de: ${s.enum.join(', ')}.`) });
      if (typeof v === 'string' && typeof s.pattern === 'string' && type === 'string') {
        let re = null;
        try { re = new RegExp(s.pattern, 'u'); } catch {}
        if (re && !re.test(v)) errors.push({ pointer: ptr(f), code: 'format', detail: t(`${f} does not match ${s.pattern}.`, `${f} no encaja con ${s.pattern}.`) });
      }
    }
    if (errors.length) throw invalid(errors, label);
  }
  function languageErrors(coll, body, current) {
    const errors = [];
    const patch = current !== undefined;
    for (const f of Object.keys(coll.types).filter((m) => coll.types[m] === 'map' && m in body)) {
      const v = body[f];
      if (v === null && patch) continue;
      if (!isObject(v)) { errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be an object of translations, such as {"en": "…"}.`, `${f} tiene que ser un objeto de traducciones, como {"en": "…"}.`) }); continue; }
      for (const [tag, s] of Object.entries(v)) {
        const where = ptr(f) + ptr(tag);
        if (!TAG.test(tag)) errors.push({ pointer: where, code: 'format', detail: t(`${tag} is not a well-formed language tag in lowercase.`, `${tag} no es una etiqueta de idioma bien formada en minúsculas.`) });
        if (s === null && patch) continue;
        if (typeof s !== 'string') errors.push({ pointer: where, code: 'type', detail: t('A translation must be a string.', 'Una traducción tiene que ser una cadena.') });
      }
    }
    return errors;
  }
  const withMaps = (coll, row) => ({ ...row, ...Object.fromEntries(Object.keys(coll.types).filter((f) => coll.types[f] === 'map' && row[f] == null).map((f) => [f, {}])) });
  const same = (a, b) => (a == null || b == null ? a == null && b == null
    : typeof a === 'string' && typeof b === 'string' && DECIMAL.test(a) && DECIMAL.test(b) ? cmpDecimal(a, b) === 0 : canonical(a) === canonical(b));
  function inheritErrors(coll, body, current) {
    const errors = [];
    for (const [f, rule] of Object.entries(coll.inherit)) {
      if (!(f in body)) continue;
      let now;
      try { now = current ? current[f] : source(db, coll, { ...body, id: '' }, f, coll.key ?? '').value; } catch { now = undefined; }
      if (!same(body[f], now)) errors.push({ pointer: ptr(f), code: 'read_only', detail: t(`${f} is the effective value; write ${rule.own}.`, `${f} es el valor efectivo; escribe en ${rule.own}.`) });
      delete body[f];
    }
    return errors;
  }
  // 5.1: a relation to an item that does not exist gives unknown on its id; one with its current value is ignored without
  // looking it up, so sending back a representation as it was read never fails because of it.
  const linkIds = (v) => [].concat(v ?? []).map((o) => (isObject(o) ? `${o.type ?? ''}/${o.id}/${o.href ?? ''}` : JSON.stringify(o))).join(',');
  // The items of the subcollection a relation leads to, under an item: [{ id, href }].
  function children(coll, row, r) {
    const sub = db[coll.relations[r].derived], k = childKey(coll.key ?? '', row?.id);
    return row ? [...(sub?.scopes.get(k)?.values() ?? [])].map((x) => linkTo(sub, k, x.id, false)) : [];
  }
  function relationErrors(coll, body, id, current) {
    const errors = [];
    for (const [r, d] of Object.entries(coll.relations)) {
      if (!(r in body)) continue;
      const now = d.derived ? children(coll, current, r) : current ? current[r] ?? (d.many ? [] : null) : d.many ? [] : null;
      // 9: a relation that leads to a subcollection is not written: with its current value it is ignored; with another, read_only.
      if (d.derived) {
        if (linkIds(body[r]) !== linkIds(now)) errors.push({ pointer: ptr(r), code: 'read_only', detail: t(`${r} lists the items of ${d.derived}: write them there.`, `${r} lista los elementos de ${d.derived}: escríbelos allí.`) });
        delete body[r];
        continue;
      }
      if (body[r] === null) continue;
      if (current && Array.isArray(body[r]) === Array.isArray(now) && linkIds(body[r]) === linkIds(now)) {
        body[r] = current[r] === undefined ? body[r] : structuredClone(current[r]); continue;
      }
      const multi = Array.isArray(d.to);
      const one = (v, where) => {
        if (!isObject(v) || typeof v.id !== 'string' || (multi && typeof v.type !== 'string')) {
          errors.push({ pointer: where, code: 'type', detail: t(`${r} must be an object with an id${multi ? ' and a type' : ''}.`, `${r} tiene que ser un objeto con un id${multi ? ' y un type' : ''}.`) });
          return v;
        }
        // 5.1: an item of a subcollection is linked with its href as it was read; one that is not the path
        // of an item of that collection, or whose last segment is not the id sent, gives 422.
        const target = db[multi ? v.type : d.to];
        const clean = { id: v.id, ...(multi && { type: v.type }), ...(target?.parent && { href: v.href }) };
        if (target?.parent) {
          const m = parseHref(db, v.href);
          if (!m || m.coll !== target || m.id !== v.id) {
            errors.push({ pointer: `${where}/href`, code: typeof v.href === 'string' ? 'format' : 'required', detail: t(`${r} links an item of ${target.name}: send its href, as read.`, `${r} enlaza un elemento de ${target.name}: envía su href, tal como se leyó.`) });
            return clean;
          }
        }
        const found = targetOf(db, coll, r, clean);
        if (!found || !found[1]) errors.push({ pointer: `${where}/id`, code: 'unknown', detail: t(`There is no ${multi ? v.type : d.to} ${v.id}.`, `No hay ningún ${multi ? v.type : d.to} ${v.id}.`) });
        else if (found[0].name === coll.name && id !== undefined) {
          for (let cur = v.id, hops = 0; cur && hops <= coll.rows.size; cur = coll.rows.get(cur)?.[r]?.id, hops++)
            if (cur === id) { errors.push({ pointer: where, code: 'cycle', detail: t(`${r} would make ${id} its own ancestor.`, `${r} haría de ${id} su propio antecesor.`) }); break; }
        }
        return clean;
      };
      if (d.many) {
        if (!Array.isArray(body[r])) { errors.push({ pointer: ptr(r), code: 'type', detail: t(`${r} must be a list of objects with an id.`, `${r} tiene que ser una lista de objetos con id.`) }); continue; }
        body[r] = body[r].map((v, k) => one(v, `${ptr(r)}/${k}`));
      } else {
        if (Array.isArray(body[r])) { errors.push({ pointer: ptr(r), code: 'type', detail: t(`${r} must be an object with an id, or null.`, `${r} tiene que ser un objeto con un id, o null.`) }); continue; }
        body[r] = one(body[r], ptr(r));
      }
    }
    return errors;
  }
  // Deleting an item removes the links that pointed to it (by id or, in a subcollection, by href) and deletes its
  // whole subcollections: a subcollection exists as long as its parent item does (5.1).
  function unlink(coll, id, key = '') {
    const gone = [[coll, key, id]];
    const prefix = childKey(key, id);
    for (const sub of Object.values(db)) {
      if (!sub.ancestors.includes(coll.name)) continue;
      for (const k of [...sub.scopes.keys()]) {
        if (k !== prefix && !k.startsWith(`${prefix}/`)) continue;
        for (const r of sub.scopes.get(k).keys()) gone.push([sub, k, r]);
        sub.scopes.delete(k); // their ids remain in usedByKey: they are not given again
      }
    }
    // 5.9: the singletons that hang from a deleted item go with it.
    for (const sg of childSingletons) if (sg.parent === coll.name || db[sg.parent]?.ancestors.includes(coll.name))
      for (const k of [...sg.rows.keys()]) if (k === prefix || k.startsWith(`${prefix}/`)) sg.rows.delete(k);
    for (const [c, k, i] of gone) {
      for (const other of Object.values(db)) {
        for (const [r, d] of Object.entries(other.relations)) {
          if (![].concat(d.to).includes(c.name) || d.derived) continue;
          const hit = (o) => isObject(o) && o.id === i && (!Array.isArray(d.to) || o.type === c.name) && (!c.parent || parseHref(db, o.href)?.key === k);
          for (const [sk, rows] of other.scopes) for (const [rk, row] of rows) {
            if (Array.isArray(row[r]) && row[r].some(hit)) rows.set(rk, { ...row, [r]: row[r].filter((o) => !hit(o)) });
            else if (hit(row[r])) rows.set(rk, { ...row, [r]: null });
            void sk;
          }
        }
      }
    }
  }
  // 7.1: a Structured Fields String without parameters, of a principal and a target (method and path, without the
  // query). Without credentials, all requests are one anonymous principal; with "anonymous": false,
  // its key is rejected with 400 before any effect.
  const anonymousRefused = isObject(served.idempotency) && served.idempotency.anonymous === false;
  function idempotencyScope(req, path) {
    if (!has('writes')) return null; // 7.1: a core-only server does not know the header
    const raw = req.headers['idempotency-key'];
    if (raw === undefined) return null;
    const m = raw.trim().match(/^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/);
    if (!m) throw new Problem(400, 'bad_request', t('Idempotency-Key must be a quoted string without parameters, such as "8e03978e-40d5".', 'Idempotency-Key tiene que ser una cadena entre comillas y sin parámetros, como "8e03978e-40d5".'),
      { errors: [{ header: 'Idempotency-Key', code: 'format', detail: t('Not a Structured Fields string without parameters.', 'No es una cadena de Structured Fields sin parámetros.') }] });
    const anonymous = req.headers.authorization === undefined && req.headers.cookie === undefined;
    if (anonymous && anonymousRefused) throw new Problem(400, 'bad_request', t('This API does not take Idempotency-Key without credentials.', 'Esta API no admite Idempotency-Key sin credenciales.'),
      { errors: [{ header: 'Idempotency-Key', code: 'unknown', detail: t('Send it with credentials, or without the header.', 'Envíala con credenciales, o sin la cabecera.') }] });
    return `${hash(req.headers.authorization ?? 'anonymous')} ${req.method} ${path} ${m[1]}`;
  }
  // 5.1: who chooses the id. A client's follows §3 and, if the create schema says so, its pattern.
  const ID = /^[A-Za-z0-9._~-]{1,64}$/;
  function idErrors(coll, body) {
    if (!('id' in body)) return coll.idFrom === 'client' ? [{ pointer: '/id', code: 'required', detail: t('Choose the id of the new item.', 'Elige el id del ítem nuevo.') }] : [];
    if (coll.idFrom === 'server') return [{ pointer: '/id', code: 'read_only', detail: t('The server assigns id.', 'El servidor asigna el id.') }];
    if (typeof body.id !== 'string') return [{ pointer: '/id', code: 'type', detail: t('id must be a string.', 'id tiene que ser una cadena.') }];
    let re = null;
    try { re = coll.idPattern ? new RegExp(coll.idPattern, 'u') : null; } catch {}
    if (!ID.test(body.id) || body.id === '.' || body.id === '..' || (re && !re.test(body.id)))
      return [{ pointer: '/id', code: 'format', detail: t('id takes 1 to 64 of A-Z a-z 0-9 - . _ ~, and is not . or ..', 'id lleva de 1 a 64 de A-Z a-z 0-9 - . _ ~, y no es . ni ..') }];
    return [];
  }
  // 5.1: a read-only field with its current value is ignored; with another, read_only. In a POST, a field only the
  // server sets is ignored whatever its value; for any other, the value the item would receive is none: only
  // null is ignored.
  function readOnlyErrors(coll, body, current) {
    const errors = [];
    for (const f of coll.readOnly) {
      if (!(f in body)) continue;
      if (!current && coll.serverOnly?.includes(f)) { delete body[f]; continue; }
      if (current ? canonical(body[f]) === canonical(current[f] ?? null) || same(body[f], current[f]) : body[f] === null) { delete body[f]; continue; }
      errors.push({ pointer: ptr(f), code: 'read_only', detail: t(`${f} is read-only.`, `${f} es de solo lectura.`) });
      delete body[f];
    }
    return errors;
  }

  // 3 and 5.1: a localized field is read-only. Its value is current when it equals its text in any language the
  // server offers (in a POST, that of the map sent, or null); then it is ignored, and otherwise read_only.
  function localizedErrors(coll, body, current) {
    const errors = [];
    for (const [f, src] of Object.entries(coll.localized ?? {})) {
      if (!(f in body)) continue;
      const map = current ? current[src] : body[src];
      const texts = isObject(map) ? Object.values(map) : [];
      const nullable = !current || coll.langs.some((l) => typeof map?.[l] !== 'string');
      if ((body[f] === null && nullable) || texts.includes(body[f])) { delete body[f]; continue; }
      errors.push({ pointer: ptr(f), code: 'read_only', detail: t(`${f} is the text of ${src} in one language: write ${src}.`, `${f} es el texto de ${src} en un idioma: escribe en ${src}.`) });
      delete body[f];
    }
    return errors;
  }

  // ── Sunsets (5.5) ──
  // 5.5: only a notice that retires a resource whole puts headers on its responses: Deprecation with the notice's
  // announced instant, a Link rel="deprecation" to the explanation and, once it has a date, Sunset. They are,
  // for collection and singleton, every response of that resource and of its items; for action, every response to
  // it; for version, every response. A notice that retires only part of a resource, a profile or an extension
  // goes in deprecations only.
  const notices = (model.notices ?? []).filter((n) => !n.due);
  const epoch = (d) => { const ms = Date.parse(d.announced ?? ''); return `@${Math.floor((Number.isNaN(ms) ? Date.now() : ms) / 1000)}`; };
  function deprecationHeaders(ctx) {
    const used = notices.filter((n) => {
      if (n.scope === 'root') {
        if (n.kind === 'version') return true;
        if (n.kind === 'collection') return ctx.coll?.name === n.name;
        if (n.kind === 'singleton') return ctx.sg?.name === n.name;
        return false;
      }
      return n.kind === 'action' && n.scope === 'collection' && ctx.coll?.name === n.owner && ctx.action === n.name;
    });
    if (!used.length) return {};
    const n = used.find((x) => x.kind !== 'version') ?? used[0];
    return { Deprecation: epoch(n), Link: `${link}, <${SPEC}#versions>; rel="deprecation"`,
      ...(typeof n.sunset === 'string' && { Sunset: new Date(n.sunset).toUTCString() }) };
  }
  const retired = (when) => new Problem(410, 'retired', t(`Retired on ${when}.`, `Retirado el ${when}.`));

  // ── Routing ──
  const ONLY_READ = t('Only GET and HEAD.', 'Solo GET y HEAD.');
  // 7.1: a repeat gives the stored status and Location, and a body that gives no more than a read now:
  // none, not even an ETag, if the item no longer exists (that of its body, of its Location or, without a body, the target).
  const sendReplay = (res, [status, data, headers], coll, targetId) => {
    const rows = scope(Object.getPrototypeOf(coll), coll.key); // the rows of now, not those from before an await
    const id = data?.id ?? (headers?.Location ? decodeURIComponent(headers.Location.split('/').at(-1)) : data === undefined ? targetId : undefined);
    if (id === undefined || rows.has(id)) {
      // 7.1: a stored body that is no longer the item's current representation (the item changed since, or the
      // body is not one) carries no Content-Location, ETag or _etag, which would make a client take it as its copy.
      const row = id === undefined ? undefined : rows.get(id);
      // 7.3: a replay of a 201 without body (return=minimal) carries no ETag even if the item still exists: the
      // stored one may no longer be current and this request did not produce the current one; the client reads Location.
      if (status === 201 && data === undefined) {
        const { ETag: _t, 'Content-Location': _l, ...plain } = headers;
        return send(res, status, undefined, { ...plain, 'Idempotent-Replayed': 'true' });
      }
      const current = row !== undefined && headers.ETag !== undefined
        && (localizes(coll) ? coll.langs : [undefined]).some((l) => tagOf(coll, row, l) === headers.ETag);
      if (!current && (headers.ETag !== undefined || headers['Content-Location'] !== undefined || (isObject(data) && '_etag' in data))) {
        const { ETag: _t, 'Content-Location': _l, ...plain } = headers;
        const body = isObject(data) ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== '_etag')) : data;
        return send(res, status, body, { ...plain, 'Idempotent-Replayed': 'true' });
      }
      return send(res, status, data, { ...headers, 'Idempotent-Replayed': 'true' });
    }
    const { ETag, ...rest } = headers;
    return send(res, status, undefined, { ...rest, 'Idempotent-Replayed': 'true' });
  };
  const missing = (url) => new Problem(404, 'not_found', t(`${url.pathname} does not exist.`, `${url.pathname} no existe.`));
  const discoveryTag = etag(served);
  const singletonByPath = new Map(Object.values(model.singletons ?? {}).filter((sg) => !db[sg.parent]).map((sg) => [sg.path, sg]));
  const childSingletons = Object.values(model.singletons ?? {}).filter((sg) => db[sg.parent]);
  async function handle(req, res) {
    refresh(db);
    req.extra = {};
    const url = new URL(req.url, 'http://localhost');
    const params = url.searchParams;
    const method = req.method;
    const read = method === 'GET' || method === 'HEAD';
    const prefer = /(^|[ ,;])return=minimal\b/.test(req.headers.prefer ?? '');
    const applied = prefer ? { 'Preference-Applied': 'return=minimal' } : {};

    if (status && url.pathname === status) {
      if (!read) throw new Problem(405, 'method_not_allowed', ONLY_READ, {}, { Allow: 'GET, HEAD' });
      res.writeHead(200, { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' });
      return res.end(method === 'HEAD' ? undefined : JSON.stringify({ status: 'pass' }));
    }
    if (Object.hasOwn(schemaPaths, url.pathname)) { // schemas linked from the discovery document (4.3)
      if (!read) throw new Problem(405, 'method_not_allowed', ONLY_READ, {}, { Allow: 'GET, HEAD' });
      return send(res, 200, schemaPaths[url.pathname], { 'Cache-Control': 'public, max-age=300', ETag: etag(schemaPaths[url.pathname]) }, method === 'HEAD');
    }
    if (url.pathname === '/') {
      req.extra = deprecationHeaders({ method, params });
      if (!read) throw new Problem(405, 'method_not_allowed', ONLY_READ, {}, { Allow: 'GET, HEAD' });
      for (const key of new Set(params.keys())) if (isReserved(reservedName(key))) throw unsupported(key);
      const headers = { ETag: discoveryTag, 'Cache-Control': 'public, max-age=300', ...req.extra };
      if (weakMatch(req.headers['if-none-match'], discoveryTag)) return send(res, 304, undefined, headers);
      return send(res, 200, served, headers, method === 'HEAD');
    }
    // 3: each path segment is compared after decoding, so /books/%37 is /books/7.
    let segments;
    // 5.1: item paths have no trailing slash, so /books/7/ is not /books/7.
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) throw missing(url);
    try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw missing(url); }
    const path = `/${segments.join('/')}`;
    // 5.9: a singleton, also one that hangs from an item (its template filled with the ids of the parent items).
    const singletonAt = (segs) => {
      const top = singletonByPath.get(`/${segs.join('/')}`);
      if (top) return [top, ''];
      for (const child of childSingletons) {
        if (child.segs.length !== segs.length || !child.segs.every((x, i) => isVar(x) || x === segs[i])) continue;
        const key = child.segs.map((x, i) => (isVar(x) ? segs[i] : null)).filter((x) => x !== null).join('/');
        if (!parentExists(db, child, key)) throw missing(url);
        return [child, key];
      }
      return null;
    };
    const sgAt = singletonAt(segments);
    if (sgAt) return handleSingleton(sgAt[0], sgAt[1], req, res, params, url);
    // 11.1: an action's name follows a colon in the last segment (also as %3A).
    const last = segments.at(-1) ?? '', colon = last.indexOf(':');
    const actionName = colon >= 0 ? last.slice(colon + 1) : undefined;
    if (colon >= 0) segments[segments.length - 1] = last.slice(0, colon);
    const sgActed = actionName !== undefined ? singletonAt(segments) : null;
    if (sgActed) return handleSingletonAction(sgActed[0], sgActed[1], actionName, req, res, params, url);
    // The collection (or subcollection, with its parents' ids) whose template matches the path.
    const found = match(db, segments);
    // 5.1: the bytes of an uploaded file, a resource outside Restep (5.9), at the item path followed by /content.
    if (!found && actionName === undefined && last === 'content') {
      const owner = match(db, segments.slice(0, -1));
      const row = owner?.id !== undefined && owner.coll.upload && parentExists(db, owner.coll, owner.key) ? owner.coll.scopes.get(owner.key)?.get(owner.id) : null;
      if (!row?._content) throw missing(url);
      if (!read) throw new Problem(405, 'method_not_allowed', ONLY_READ, {}, { Allow: 'GET, HEAD' });
      const bytes = owner.coll.files.get(childKey(owner.key, owner.id)) ?? fakeBytes(row._content.size, `${owner.coll.name}/${owner.key}/${owner.id}`);
      res.writeHead(200, { 'Content-Type': row._content.media_type, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache', ETag: `"${hash(bytes.toString('base64'))}"` });
      return res.end(method === 'HEAD' ? undefined : bytes);
    }
    if (!found || (found.id !== undefined && (found.id.includes(':') || !found.id))) throw missing(url);
    const base = found.coll, id = found.id;
    // 5.1: a path under a parent that does not exist does not exist.
    if (!parentExists(db, base, found.key)) throw missing(url);
    const coll = view(base, found.key);
    // 5.6: the language of the localized fields, by lookup over the languages of their maps.
    const lang = localizes(coll) ? pickLanguage(req.headers['accept-language'], coll.langs, model.defaultLanguage) : undefined;
    req.extra = deprecationHeaders({ coll, item: id !== undefined, method, params, action: actionName });
    // 5.4, rule 3: a repeat takes the place of the 404 of a deleted item, so a POST action with
    // Idempotency-Key reaches handleAction, which looks for the stored response first.
    const replayable = actionName !== undefined && method === 'POST' && req.headers['idempotency-key'] !== undefined;
    // 5.1: in a collection that declares upsert, a PATCH to a free id creates the item.
    const free = (x) => !coll.rows.has(x) && (coll.reusableIds || !coll.used.has(x));
    const upserting = actionName === undefined && method === 'PATCH' && id !== undefined && coll.upsert && free(id);
    if (id !== undefined && !coll.rows.has(id) && !base.retired && !replayable && !upserting) throw missing(url);
    if (base.retired) throw retired(base.retired); // 5.5: after its sunset, 410 retired
    if (actionName !== undefined) return handleAction(coll, id, actionName, req, res, params, url, lang);

    // 4.3: HEAD goes with GET (5.1); without a declared GET, HEAD also gives 405 and Allow does not list it.
    const declared = id === undefined ? coll.methods : coll.item_methods;
    const methods = declared.includes('GET') ? [...declared, 'HEAD'] : [...declared];
    if (!methods.includes(method))
      throw new Problem(405, 'method_not_allowed', t(`Supports ${methods.join(', ')}.`, `Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') });

    // 5.3: what the resource implements with this method; limit only with max_limit declared (6.4).
    const queryParams = has('query') ? (id === undefined ? ['filter', 'sort', 'fields', 'count', 'cursor', ...(coll.max_limit ? ['limit'] : [])] : ['fields']) : (id === undefined ? ['cursor'] : []);
    const allowed = !read ? [] : [...queryParams, ...(has('relations') ? ['include'] : [])];
    for (const key of new Set(params.keys())) {
      const base = reservedName(key);
      if (!isReserved(base)) continue;
      if (!allowed.includes(base)) throw unsupported(key);
      if (base !== 'filter' && key !== base) throw unsupported(key);
      if (params.getAll(key).length > 1) throw once(key);
    }
    const location = (r) => `${coll.path}/${r.id}`;
    const withTag = (row) => (has('writes') ? { ...present(coll, row, lang), _etag: tagOf(coll, row, lang) } : present(coll, row, lang));
    const langHeaders = languageHeaders(coll, lang);

    if (read) {
      let data, tag;
      if (id === undefined) { data = list(coll, params, coll.path, lang); tag = etag([lang, data]); }
      else {
        const row = coll.rows.get(id);
        const include = has('relations') ? parseInclude(coll, params) : [];
        const fields = has('query') ? parseFields(params, coll, include) : null;
        // 7.2: with fields or include it is another representation, with its own ETag; _etag is still the item's.
        data = fields || include.length ? { ...pick(present(coll, expand(coll, row, include, lang), lang), fields), ...(has('writes') && { _etag: tagOf(coll, row, lang) }) } : withTag(row);
        tag = fields || include.length ? etag([lang, data]) : tagOf(coll, row, lang);
      }
      const members = id === undefined ? data.items.map((r) => location(r)) : [location(data)];
      const headers = { ETag: tag, 'Cache-Control': 'no-cache', ...langHeaders, ...cacheGroups('Cache-Groups', id === undefined ? [coll.path, ...members] : members),
        ...deprecationHeaders({ coll, item: id !== undefined, method, params }, data) };
      if (req.headers['if-match'] !== undefined && !(id === undefined ? strongMatch(req.headers['if-match'], tag) : matchesItem(req.headers['if-match'], coll, coll.rows.get(id))))
        throw new Problem(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
      if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);
      return send(res, 200, data, headers, method === 'HEAD');
    }

    if (id === undefined) { // POST
      const scope = idempotencyScope(req, path);
      // 5.1: a collection that declares upload also takes the bytes of a file, or multipart with one part.
      // 5.1: in a collection that only takes files (onlyFiles), a JSON body is one more file, of a media type it
      // may not declare (415). Every 415 of a collection with upload carries Accept-Post with what it takes (W3C LDP 1.0, 7.1).
      let file, body, sent;
      try {
        file = coll.upload && (coll.upload.onlyFiles || !mediaTypeOk(req.headers['content-type'], ['application/json'])) ? await readUpload(coll, req) : null;
        [body, sent] = file ? [{}, { file: file.digest, media_type: file.mediaType }] : await readJson(req, ['application/json']);
      } catch (e) {
        if (coll.upload && e instanceof Problem && e.status === 415)
          e.headers = { ...e.headers, 'Accept-Post': [...new Set([...(coll.upload.onlyFiles ? [] : ['application/json']), ...coll.upload.media_types, ...(coll.upload.multipart ? ['multipart/form-data'] : [])])].join(', ') };
        throw e;
      }
      // 7.1: the same request is the same key, principal, target, query and body (as JSON values).
      const print = scope && hash(canonical([idempotencyQuery(params), sent]));
      const saved = scope && idempotency.get(scope);
      const live = saved && saved.expires > Date.now() ? saved : null;
      if (live && live.print === print) return sendReplay(res, live.response, coll);
      let collTag = null;
      try { collTag = etag([lang, list(coll, new URLSearchParams(), coll.path, lang)]); } catch {} // a required filter: no full list
      if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], collTag))
        throw new Problem(412, 'precondition_failed', t('If-Match does not match the current collection.', 'If-Match no coincide con la colección actual.'));
      if (weakMatch(req.headers['if-none-match'], collTag))
        throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current collection.', 'If-None-Match coincide con la colección actual.'));
      if (live) throw new Problem(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
      objectBody(body);
      return create(coll, body, { req, res, scope, print, lang, file, extra: { ...applied, ...req.extra } });
    }

    const [patch] = method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']) : [null];
    const current = coll.rows.get(id);
    // 5.1: upsert. If-None-Match: * makes the PATCH succeed only if it creates, If-Match only if the item exists.
    if (!current && method === 'PATCH' && coll.upsert && free(id)) {
      if (req.headers['if-match'] !== undefined)
        throw new Problem(412, 'precondition_failed', t('If-Match: the item does not exist.', 'If-Match: el ítem no existe.'));
      objectBody(patch);
      if ('id' in patch && patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id is the one in the path.', 'El id es el de la ruta.') }]);
      return create(coll, { ...mergePatch({}, patch), id }, { req, res, lang, extra: { ...applied, ...req.extra } });
    }
    if (!current) throw missing(url); // 7.2: an item deleted in the meantime gives 404, whatever the preconditions say
    if (req.headers['if-match'] !== undefined && !matchesItem(req.headers['if-match'], coll, current))
      throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
    const inm = req.headers['if-none-match'];
    if (inm !== undefined && (localizes(coll) ? coll.langs.some((l) => weakMatch(inm, tagOf(coll, current, l))) : weakMatch(inm, tagOf(coll, current))))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current item.', 'If-None-Match coincide con el ítem actual.'));
    const invalidation = { ...cacheGroups('Cache-Group-Invalidation', [coll.path, `${coll.path}/${id}`]), ...req.extra };
    if (method === 'DELETE') {
      unlink(coll, id, coll.key); coll.rows.delete(id);
      // 5.1: with reusable_ids, the id of a deleted item is free again; its next incarnation gets another ETag.
      if (coll.reusableIds) { coll.used.delete(id); bumpIncarnation(coll, id); }
      coll.files.delete(childKey(coll.key, id));
      return send(res, 204, undefined, invalidation);
    }
    objectBody(patch); // 5.1 and 5.4: after the preconditions
    if ('id' in patch && patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.', 'id no puede cambiar.') }]);
    const unknown = Object.keys(patch).filter((f) => !f.startsWith('_') && !Object.hasOwn(coll.types, f));
    if (unknown.length) throw invalid(unknown.map((f) => ({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) })));
    const errors = [...readOnlyErrors(coll, patch, current), ...localizedErrors(coll, patch, current), ...languageErrors(coll, patch, current)];
    errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));
    // 5.1: a relation is replaced whole, not merged.
    const relValues = Object.fromEntries(Object.keys(coll.relations).filter((r) => patch[r] != null).map((r) => [r, patch[r]]));
    const row = withMaps(coll, { ...mergePatch(current, patch), ...relValues, id });
    validate(coll, row, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'), errors);
    coll.rows.set(id, row);
    refresh(db);
    const stored = coll.rows.get(id);
    return send(res, prefer ? 204 : 200, prefer ? undefined : withTag(stored), { ETag: tagOf(coll, stored, lang), ...langHeaders, ...invalidation, ...applied });
  }

  // 5.1: creating an item, from a POST (JSON or a file) or from a PATCH to a free id in a collection with upsert.
  function create(coll, body, { req, res, scope, print, lang, file, extra }) {
    const errors = [...idErrors(coll, body), ...readOnlyErrors(coll, body), ...localizedErrors(coll, body)];
    // 4.3: fields that are absent take their default; one sent as null is present.
    for (const [f, v] of Object.entries(coll.createDefaults)) if (!Object.hasOwn(body, f)) body[f] = structuredClone(v);
    const chosen = 'id' in body && !errors.length ? body.id : undefined;
    delete body.id;
    if (file) for (const [f, v] of Object.entries(fileFields(coll, file))) if (!Object.hasOwn(body, f)) body[f] = v;
    validate(coll, body, undefined, [...errors, ...languageErrors(coll, body), ...relationErrors(coll, body), ...inheritErrors(coll, body)]);
    // 5.1 and 5.4: an id the collection has (or, without reusable_ids, has had) gives 409 conflict with taken, after the 422s.
    if (chosen !== undefined && (coll.rows.has(chosen) || (!coll.reusableIds && coll.used.has(chosen))))
      throw new Problem(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'), { errors: [{ pointer: '/id', code: 'taken', detail: t('An item of this collection has or had this id.', 'Un ítem de esta colección tiene o tuvo este id.') }] });
    let newId = chosen;
    if (newId === undefined) { while (coll.used.has(String(coll.nextId)) || coll.rows.has(String(coll.nextId))) coll.nextId++; newId = String(coll.nextId++); }
    const row = withMaps(coll, { ...body, id: newId });
    const location = `${coll.path}/${row.id}`;
    if (file) {
      coll.files.set(childKey(coll.key, row.id), file.bytes);
      row._content = { href: `${location}/content`, media_type: file.mediaType, size: file.bytes.length };
    }
    coll.rows.set(row.id, row);
    coll.used.add(row.id);
    refresh(db);
    const stored = coll.rows.get(row.id);
    const prefer = /(^|[ ,;])return=minimal\b/.test(req.headers.prefer ?? '');
    const response = [201, prefer ? undefined : has('writes') ? { ...present(coll, structuredClone(stored), lang), _etag: tagOf(coll, stored, lang) } : present(coll, structuredClone(stored), lang),
      { Location: location, ETag: tagOf(coll, stored, lang), ...languageHeaders(coll, lang), ...cacheGroups('Cache-Group-Invalidation', [coll.path, location]), ...extra }];
    if (scope) idempotency.set(scope, { print, response, expires: Date.now() + TTL });
    return send(res, ...response);
  }
  // 5.1: the bytes of an upload: a file of a declared media type (415 otherwise), no larger than max_size (413);
  // with "multipart": true, also multipart/form-data with exactly one part, named file.
  async function readUpload(coll, req) {
    const header = req.headers['content-type'];
    const type = (header ?? '').split(';')[0].trim().toLowerCase();
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (coll.upload.max_size === null || size <= coll.upload.max_size * 2 + 65536) chunks.push(chunk); }
    let bytes = Buffer.concat(chunks), mediaType = type;
    // 5.1: an outer multipart/form-data always selects multipart upload: 415 without "multipart": true, even when
    // media_types match it (multipart/* or */*). Any other multipart type is a file like any other.
    if (type === 'multipart/form-data') {
      if (!coll.upload.multipart) throw unsupportedFile(coll);
      const part = onePart(header, bytes);
      if (!part) throw new Problem(415, 'unsupported_media_type', t('A multipart body carries exactly one part, named file, with its Content-Type.', 'Un cuerpo multipart lleva exactamente una parte, llamada file, con su Content-Type.'));
      ({ bytes, mediaType } = part);
    }
    if (!header || !coll.upload.media_types.some((r) => r === '*/*' || r === mediaType || (r.endsWith('/*') && mediaType.startsWith(r.slice(0, -1))))) throw unsupportedFile(coll);
    if (coll.upload.max_size !== null && (size > coll.upload.max_size * 2 + 65536 || bytes.length > coll.upload.max_size))
      throw new Problem(413, 'content_too_large', t(`The file is larger than ${coll.upload.max_size} bytes.`, `El fichero ocupa más de ${coll.upload.max_size} bytes.`));
    const name = /filename="([^"]*)"/i.exec(req.headers['content-disposition'] ?? '')?.[1];
    return { bytes, mediaType, name, digest: createHash('sha256').update(bytes).digest('hex') };
  }
  const unsupportedFile = (coll) => new Problem(415, 'unsupported_media_type', coll.upload.onlyFiles
    ? t(`Send a file of type ${coll.upload.media_types.join(', ')}.`, `Envía un fichero de tipo ${coll.upload.media_types.join(', ')}.`)
    : t(`Send application/json or a file of type ${coll.upload.media_types.join(', ')}.`, `Envía application/json o un fichero de tipo ${coll.upload.media_types.join(', ')}.`));
  // RFC 7578: the single part named file of a multipart/form-data body, or null.
  function onePart(header, body) {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(header);
    if (!boundary) return null;
    const delim = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
    const pieces = [];
    for (let at = body.indexOf(delim); at >= 0;) {
      const next = body.indexOf(delim, at + delim.length);
      if (next < 0) break;
      pieces.push(body.subarray(at + delim.length, next));
      at = next;
    }
    if (pieces.length !== 1) return null;
    const piece = pieces[0], sep = piece.indexOf('\r\n\r\n');
    if (sep < 0) return null;
    const head = piece.subarray(0, sep).toString('latin1');
    const type = /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim().toLowerCase();
    // 5.1: the client sends filename, but the server does not require it: a file part without it is the file.
    if (!/content-disposition:\s*form-data;[^\r\n]*\bname="file"/i.test(head) || !type) return null;
    let bytes = piece.subarray(sep + 4);
    if (bytes.subarray(-2).toString() === '\r\n') bytes = bytes.subarray(0, -2);
    return { bytes, mediaType: type };
  }
  // The fields the mock gives an uploaded item, where its collection has them: a name and a media type.
  function fileFields(coll, file) {
    const out = {};
    for (const f of Object.keys(coll.types)) {
      if (coll.types[f] !== 'string') continue;
      if (/^(name|filename|file_name|title)$/.test(f) && file.name) out[f] = file.name;
      if (/^(media_type|content_type|mime_type)$/.test(f)) out[f] = file.mediaType;
    }
    return out;
  }
  const bumpIncarnation = (coll, id) => { const k = childKey(coll.key, id); coll.incarnations.set(k, (coll.incarnations.get(k) ?? 0) + 1); };

  // 11.1: a simulated action. The mock does not know its logic, so it changes no data: it checks what the
  // text defines (that it is declared on that kind of resource, the method, its params, the body against its input,
  // the idempotency key and the preconditions) and answers: a safe action with output, a made-up result of
  // that shape (new, the create defaults and schema); otherwise, on an item, its representation (200), and on a
  // collection, 204. An item action with return=minimal answers 204, without ETag (7.2).
  async function handleAction(coll, id, name, req, res, params, url, lang) {
    const method = req.method;
    const a = coll.actions[name];
    // An action the collection does not declare, or that is declared on the other kind of resource, does not exist.
    if (!a || a.on !== (id === undefined ? 'collection' : 'item')) throw new Problem(404, 'not_found', t(`There is no action ${name} here.`, `Aquí no hay ninguna acción ${name}.`));
    if (a.retired) throw retired(a.retired);
    const allow = a.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];
    if (!allow.includes(method)) throw new Problem(405, 'method_not_allowed', t(`Supports ${allow.join(', ')}.`, `Admite ${allow.join(', ')}.`), {}, { Allow: allow.join(', ') });
    // 5.3: an action implements no reserved parameter.
    for (const key of new Set(params.keys())) if (isReserved(reservedName(key))) throw unsupported(key);
    if (a.method === 'GET') actionParams(a, params);
    const path = `${coll.path}${id === undefined ? '' : `/${id}`}:${name}`;
    let row = id === undefined ? null : coll.rows.get(id);
    // Only a non-idempotent POST action with a key can get here without its item (the repeat goes first).
    if (id !== undefined && !row && (a.method === 'GET' || a.idempotent)) throw missing(url);
    const langHeaders = languageHeaders(coll, lang);
    // 11.1: the response of a safe action: its result with output (not a representation: no _etag), the item, or
    // 204 on a collection.
    const result = () => (name === 'new' ? { values: structuredClone(coll.createDefaults), schema: structuredClone(coll.createSchema ?? { type: 'object' }) }
      : a.output ? sample(a.output, rngFor(seed, coll.name, name, id ?? '', canonical(idempotencyQuery(params))))
      : row ? { ...present(coll, row, lang), ...(has('writes') && { _etag: tagOf(coll, row, lang) }) } : undefined);
    if (a.method === 'GET') {
      const data = result();
      if (data === undefined) return send(res, 204, undefined, { 'Cache-Control': 'no-cache', ...req.extra });
      const own = a.output || name === 'new';
      return send(res, 200, data, { 'Cache-Control': 'no-cache', ETag: own ? etag(data) : tagOf(coll, row, lang), ...(!own && langHeaders), ...req.extra }, method === 'HEAD');
    }
    // 7.1 and 11.1: a non-idempotent action accepts Idempotency-Key (malformed, or without credentials with
    // "anonymous": false, gives 400); an idempotent one never rejects it: it ignores it and stores nothing.
    const scope = a.idempotent ? null : idempotencyScope(req, path);
    const [body, sent] = await readActionBody(req);
    const print = scope && hash(canonical([idempotencyQuery(params), sent]));
    const saved = scope && idempotency.get(scope);
    const live = saved && saved.expires > Date.now() ? saved : null;
    if (live && live.print === print) return sendReplay(res, live.response, coll, id);
    // The item as it is now: another request may have changed or deleted it while the body was arriving.
    if (id !== undefined) { row = coll.rows.get(id); if (!row) throw missing(url); }
    // 7.2: the target of an item action is the item; that of a collection action, the collection.
    if (req.headers['if-match'] !== undefined && !(row ? matchesItem(req.headers['if-match'], coll, row) : strongMatch(req.headers['if-match'], collectionTag(coll, lang))))
      throw new Problem(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
    if (weakMatch(req.headers['if-none-match'], row ? tagOf(coll, row, lang) : collectionTag(coll, lang)))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current representation.', 'If-None-Match coincide con la representación actual.'));
    if (live) throw new Problem(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
    objectBody(body);
    // 4.3: the body against the input schema, after removing the members that start with _.
    if (a.input) {
      const errors = jsonErrors(a.input, body);
      if (errors.length) throw invalid(errors.map((e) => ({ ...e, detail: t(`${e.pointer || 'The body'} does not fit the input schema (${e.code}).`, `${e.pointer || 'El cuerpo'} no encaja con el esquema input (${e.code}).`) })));
    }
    const prefer = /(^|[ ,;])return=minimal\b/.test(req.headers.prefer ?? '');
    const data = a.safe ? result() : row && !prefer ? result() : undefined;
    const response = data !== undefined && !prefer
      ? [200, data, { ...(!a.output && row && { ETag: tagOf(coll, row, lang) }), ...(!a.output && langHeaders), ...req.extra }]
      : [204, undefined, { ...(row && prefer && { 'Preference-Applied': 'return=minimal' }), ...req.extra }];
    if (scope) idempotency.set(scope, { print, response, expires: Date.now() + TTL });
    return send(res, ...response);
  }
  // 11.1: the query parameters of a GET action: an undeclared one gives unsupported_parameter; a required one
  // missing, a repeated one, a value that does not fit its type and an empty list, invalid_parameter.
  function actionParams(a, params) {
    for (const key of new Set(params.keys())) {
      const p = a.params[key];
      if (!p) throw unsupported(key, t(`This action takes no parameter ${key}.`, `Esta acción no admite el parámetro ${key}.`));
      if (params.getAll(key).length > 1) throw once(key);
      const raw = params.get(key);
      const type = p.type === 'enum' ? p.values ?? [] : p.type;
      if (p.list) {
        if (raw === '') throw bad(key, t(`${key} needs a non-empty, comma-separated list.`, `${key} necesita una lista no vacía, separada por comas.`));
        raw.split(',').forEach((v) => parseValue(type, v, key));
      } else parseValue(type, raw, key);
    }
    for (const [k, p] of Object.entries(a.params)) if (p.required && !params.has(k)) throw bad(k, t(`${k} is required.`, `${k} es obligatorio.`));
  }
  const collectionTag = (coll, lang) => { try { return etag([lang, list(coll, new URLSearchParams(), coll.path, lang)]); } catch { return null; } };
  // 11.1: an action of a singleton, at {path}:{name}: as an item action, on the singleton's object.
  async function handleSingletonAction(sg, key, name, req, res, params, url) {
    const method = req.method;
    const a = sg.actions[name];
    if (!a) throw new Problem(404, 'not_found', t(`There is no action ${name} here.`, `Aquí no hay ninguna acción ${name}.`));
    req.extra = deprecationHeaders({ sg, method, params });
    if (sg.retired) throw retired(sg.retired);
    const allow = a.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];
    if (!allow.includes(method)) throw new Problem(405, 'method_not_allowed', t(`Supports ${allow.join(', ')}.`, `Admite ${allow.join(', ')}.`), {}, { Allow: allow.join(', ') });
    for (const k of new Set(params.keys())) if (isReserved(reservedName(k))) throw unsupported(k);
    if (a.method === 'GET') actionParams(a, params);
    if (key && !sg.rows.has(key)) sg.rows.set(key, genSingleton(sg, key));
    const row = key ? sg.rows.get(key) : sg.row;
    const result = () => (a.output ? sample(a.output, rngFor(seed, sg.name, name, key, canonical(idempotencyQuery(params)))) : has('writes') ? { ...row, _etag: etag(row) } : row);
    if (a.method === 'GET') {
      const data = result();
      return send(res, 200, data, { 'Cache-Control': 'no-cache', ETag: a.output ? etag(data) : etag(row), ...req.extra }, method === 'HEAD');
    }
    const scope = a.idempotent ? null : idempotencyScope(req, `${url.pathname}`);
    const [body, sent] = await readActionBody(req);
    const print = scope && hash(canonical([idempotencyQuery(params), sent]));
    const saved = scope && idempotency.get(scope);
    const live = saved && saved.expires > Date.now() ? saved : null;
    if (live && live.print === print) return send(res, live.response[0], live.response[1], { ...live.response[2], 'Idempotent-Replayed': 'true' });
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], etag(row)))
      throw new Problem(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
    if (weakMatch(req.headers['if-none-match'], etag(row)))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current representation.', 'If-None-Match coincide con la representación actual.'));
    if (live) throw new Problem(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
    objectBody(body);
    if (a.input) {
      const errors = jsonErrors(a.input, body);
      if (errors.length) throw invalid(errors.map((e) => ({ ...e, detail: t(`${e.pointer || 'The body'} does not fit the input schema (${e.code}).`, `${e.pointer || 'El cuerpo'} no encaja con el esquema input (${e.code}).`) })));
    }
    const prefer = /(^|[ ,;])return=minimal\b/.test(req.headers.prefer ?? '');
    const response = !prefer || (a.safe && a.output) ? [200, result(), { ...(!a.output && { ETag: etag(row) }), ...req.extra }]
      : [204, undefined, { 'Preference-Applied': 'return=minimal', ...req.extra }];
    if (scope) idempotency.set(scope, { print, response, expires: Date.now() + TTL });
    return send(res, ...response);
  }
  // 11.1: an empty body, with or without Content-Type, is {} as application/json; a non-empty one follows §3.
  async function readActionBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (raw === '') return [{}, {}];
    if (!mediaTypeOk(req.headers['content-type'], ['application/json']))
      throw new Problem(415, 'unsupported_media_type', t('Send application/json, in UTF-8, or an empty body.', 'Envía application/json, en UTF-8, o un cuerpo vacío.'));
    return parseBody(raw);
  }

  // 5.9: a singleton behaves like an item with no id or collection. GET (and HEAD) and, if declared, PATCH;
  // POST and DELETE give 405. With a query, fields; any other reserved parameter, unsupported_parameter.
  async function handleSingleton(sg, key, req, res, params, url) {
    const method = req.method, read = method === 'GET' || method === 'HEAD';
    // 5.9: one that hangs from an item has its own object under each parent item.
    const ids = key ? key.split('/') : [];
    const spath = key ? `/${sg.segs.map((x) => (isVar(x) ? ids.shift() : x)).join('/')}` : sg.path;
    if (key && !sg.rows.has(key)) sg.rows.set(key, genSingleton(sg, key));
    const rowNow = () => (key ? sg.rows.get(key) : sg.row);
    const withTag = (row) => (has('writes') ? { ...row, _etag: etag(row) } : row);
    const prefer = /(^|[ ,;])return=minimal\b/.test(req.headers.prefer ?? '');
    req.extra = deprecationHeaders({ sg, method, params });
    if (sg.retired) throw retired(sg.retired);
    const allow = [...sg.methods, 'HEAD'];
    if (!allow.includes(method))
      throw new Problem(405, 'method_not_allowed', t(`Supports ${allow.join(', ')}.`, `Admite ${allow.join(', ')}.`), {}, { Allow: allow.join(', ') });
    for (const key of new Set(params.keys())) {
      const base = reservedName(key);
      if (!isReserved(base)) continue;
      if (!read || base !== 'fields' || key !== base || !has('query')) throw unsupported(key);
      if (params.getAll(key).length > 1) throw once(key);
    }
    if (read) {
      const fields = has('query') ? parseFields(params, sg, []) : null;
      const row = rowNow();
      const data = fields ? { ...pick(row, fields), ...(has('writes') && { _etag: etag(row) }) } : withTag(row);
      if (!('id' in row)) delete data.id;
      const headers = { ETag: fields ? etag(data) : etag(row), 'Cache-Control': 'no-cache', ...cacheGroups('Cache-Groups', [spath]),
        ...deprecationHeaders({ sg, method, params }, data) };
      if (weakMatch(req.headers['if-none-match'], headers.ETag)) return send(res, 304, undefined, headers);
      return send(res, 200, data, headers, method === 'HEAD');
    }
    const [patch] = await readJson(req, ['application/merge-patch+json', 'application/json']);
    const current = rowNow();
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
    if (weakMatch(req.headers['if-none-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current representation.', 'If-None-Match coincide con la representación actual.'));
    objectBody(patch);
    const unknown = Object.keys(patch).filter((f) => !f.startsWith('_') && !Object.hasOwn(sg.types, f));
    if (unknown.length) throw invalid(unknown.map((f) => ({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) })));
    const errors = readOnlyErrors(sg, patch, current);
    const merged = mergePatch(current, patch);
    const row = Object.fromEntries(Object.keys(sg.types).filter((f) => f in merged).map((f) => [f, merged[f]])); // always in the same order, for the ETag
    validate(sg, row, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'), errors);
    if (key) sg.rows.set(key, row); else sg.row = row;
    return send(res, prefer ? 204 : 200, prefer ? undefined : withTag(row), { ETag: etag(row), ...cacheGroups('Cache-Group-Invalidation', [spath]), ...req.extra,
      ...(prefer && { 'Preference-Applied': 'return=minimal' }) });
  }

  // Simulated latency and failures: deterministic by seed, in the order the requests arrive.
  const chaos = rngFor(seed, 'chaos');
  const [lo, hi] = options.latency ?? [0, 0];
  const failRate = options.failRate ?? 0;
  return createServer(async (req, res) => {
    const delay = lo + Math.floor(chaos() * (hi - lo + 1));
    const fail = failRate > 0 && chaos() < failRate;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const url = new URL(req.url, 'http://localhost');
    // The service status (4.4) does not go down with the simulated API: that is how a transient failure is told apart.
    if (fail && url.pathname !== status) {
      req.resume();
      return problem(res, new Problem(503, 'unavailable', t('Simulated outage: try again later.', 'Caída simulada: vuelve a intentarlo más tarde.'), {},
        { 'Retry-After': String(options.retryAfter ?? 1) }), req);
    }
    handle(req, res).catch((e) => {
      if (!(e instanceof Problem)) { console.error(e); e = new Problem(500, 'internal', t('Something went wrong on the server.', 'Algo ha fallado en el servidor.')); }
      if (!res.headersSent) problem(res, e, req);
    });
  });
}

// ── Program ───────────────────────────────────────────────────────────────────
export async function prepare(source, { seed = 1, count = 50, counts = {} } = {}) {
  const { doc, linked } = await loadDiscovery(source);
  const model = buildModel(doc, linked);
  generate(model, seed, counts, count);
  // Linked schemas with an absolute path are served at the same path.
  const served = Object.fromEntries(Object.entries(linked).filter(([k]) => k.startsWith('/')));
  return { model, linked: served };
}
// The generated data: one list per collection; for a subcollection, one list per collection path.
export const dumpData = (model) => Object.fromEntries(Object.entries(model.db).map(([n, c]) => [n, c.parent
  ? Object.fromEntries([...c.scopes].map(([k, rows]) => [itemPath(c, k), [...rows.values()]]))
  : [...c.rows.values()]]));

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`restep-mock: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  if (!o.source) { console.error('restep-mock: missing the discovery document (a JSON file or a URL). See --help.'); process.exit(2); }
  let prepared;
  try { prepared = await prepare(o.source, o); } catch (e) { console.error(`restep-mock: ${e.message}`); process.exit(2); }
  const { model, linked } = prepared;
  if (!o.quiet) for (const w of warnings) console.error(`warning: ${w}`);
  if (o.dump) { process.stdout.write(`${JSON.stringify(dumpData(model), null, 2)}\n`); return; }
  for (const c of Object.keys(o.counts)) if (!model.db[c]) console.error(`warning: --count ${c}=… matches no simulated collection.`);
  const server = createMock(model, { seed: o.seed, latency: o.latency, failRate: o.failRate, retryAfter: o.retryAfter, linked });
  server.on('error', (e) => { console.error(`restep-mock: cannot listen on port ${o.port}: ${e.code ?? e.message}`); process.exit(2); });
  server.listen(o.port, o.host, () => {
    const { port } = server.address();
    const sizes = Object.values(model.db).map((c) => `${c.name} (${[...entries(c)].length})`).join(', ');
    console.log(`restep-mock ${VERSION} · Restep 1 (${model.profiles.join(', ')}) at http://localhost:${port}/`);
    console.log(`Collections: ${sizes || 'none'} · seed ${o.seed}` +
      `${o.latency[1] ? ` · latency ${o.latency[0]}-${o.latency[1]} ms` : ''}${o.failRate ? ` · failures ${o.failRate * 100}%` : ''}`);
  });
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const invoked = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) main();
