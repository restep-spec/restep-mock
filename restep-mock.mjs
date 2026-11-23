#!/usr/bin/env node
// restep-mock · API Restep 1 falsa a partir de un documento de descubrimiento.
// Node 18 o posterior, sin dependencias.
//   npx restep-mock <discovery.json | URL> [--port N] [--seed N] [--count 50] [--latency 0-300] [--fail-rate 0.05]
// Genera datos plausibles y deterministas (por semilla) según el tipo y el nombre de cada campo, y se
// comporta como un servidor real del borrador 6 (https://restep.wubytes.com/1/, "restep": "1.0-draft.6")
// en los perfiles core, query, writes, cache y relations y la extensión inherit: filtros, colaciones, orden,
// fields, paginación con cursores firmados, recuento, errores problem+json, parámetros reservados que fallan
// en voz alta, tipos de medio, id_from, singletons, escrituras en memoria con Idempotency-Key,
// ETag/If-Match/If-None-Match, mapas de idioma, valores heredados (11.6) y avisos de retirada (5.5).
// Gran parte del código viene del servidor de referencia (vendor/restep-server.mjs).
// También subcolecciones (a cualquier profundidad) y la extensión actions, con acciones simuladas.
// Lo que no implementa (sync y las demás extensiones) lo quita del descubrimiento que sirve y lo avisa por
// la salida de errores, para no anunciar nada que no cumple.
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const VERSION = '0.4.1';
const PROFILE = 'https://w3id.org/restep/1/'; // identificador: enlace de perfil y tipos de error
const SPEC = 'https://restep.wubytes.com/1/'; // la página para leer
// 1.1: el mock implementa el texto del borrador 6 y lo declara así, sea cual sea la versión del documento de
// partida: un servidor implementa el texto de la versión que declara en restep (1.2).
const RESTEP = '1.0-draft.6';
const RESTEP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(draft|rc)\.(0|[1-9]\d*))?$/;
const SUPPORTED_PROFILES = ['core', 'query', 'writes', 'cache', 'relations'];
const SUPPORTED_EXTENSIONS = ['actions', 'inherit'];
// 5.5: dónde va cada kind de aviso de retirada.
const KINDS = {
  root: ['version', 'profile', 'extension', 'collection', 'singleton', 'reason'],
  collection: ['field', 'filter', 'operator', 'value', 'sort', 'relation', 'include', 'count', 'max_limit', 'action', 'method', 'item_method'],
  singleton: ['field', 'method'],
};
// Pasada la fecha, el mock aplica la retirada de estos kinds; los avisos vencidos de los demás no los
// sirve (y lo avisa), porque no sabe simularlos.
const RETIRES = ['filter', 'operator', 'sort', 'include', 'count', 'max_limit', 'method', 'item_method', 'action', 'collection', 'singleton'];
// 3: la gramática de los nombres (acciones, entre otros).
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// ── Línea de órdenes ──────────────────────────────────────────────────────────
const HELP = `restep-mock ${VERSION} · API Restep 1 falsa a partir de un documento de descubrimiento

Uso: restep-mock <discovery.json | URL> [opciones]

  --port <n>             Puerto (por defecto 8090; 0 elige uno libre)
  --host <host>          Interfaz en la que escucha (por defecto, todas)
  --seed <n>             Semilla de los datos, de los cursores y de los fallos (por defecto 1)
  --count <n>            Elementos por colección (por defecto 50)
  --count <col>=<n>      Elementos de una colección concreta (repetible)
  --latency <ms|a-b>     Retraso de cada respuesta: fijo (120) o aleatorio en un rango (0-300)
  --fail-rate <0..1>     Fracción de peticiones que responden 503 unavailable con Retry-After
  --retry-after <s>      Segundos de Retry-After en esos 503 (por defecto 1)
  --dump                 Escribe los datos generados en JSON por la salida estándar y termina
  --quiet                Sin avisos por la salida de errores
  -h, --help             Esta ayuda

La semilla hace los datos reproducibles: misma semilla y mismo descubrimiento, mismos datos.
Las escrituras viven en memoria y se pierden al parar.`;

function parseArgs(argv) {
  const o = { source: null, port: 8090, host: undefined, seed: 1, count: 50, counts: {}, latency: [0, 0],
    failRate: 0, retryAfter: 1, dump: false, quiet: false };
  const value = (i, name) => {
    if (i >= argv.length) throw new Error(`Falta el valor de ${name}.`);
    return argv[i];
  };
  const int = (v, name, min = 0) => {
    if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} tiene que ser un entero mayor o igual que ${min}: ${v}`);
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
      if (!m || (m[2] !== undefined && Number(m[2]) < Number(m[1]))) throw new Error(`--latency espera milisegundos (120) o un rango (0-300): ${v}`);
      o.latency = [Number(m[1]), Number(m[2] ?? m[1])];
    } else if (a === '--fail-rate') {
      const v = value(++i, a), n = Number(v);
      if (!/^\d*\.?\d+$/.test(v) || n < 0 || n > 1) throw new Error(`--fail-rate espera un número entre 0 y 1: ${v}`);
      o.failRate = n;
    } else if (a === '--retry-after') o.retryAfter = int(value(++i, a), a);
    else if (a === '--dump') o.dump = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('-')) throw new Error(`Opción desconocida: ${a}. Mira --help.`);
    else if (o.source) throw new Error(`Sobra un argumento: ${a}. Solo se admite un documento de descubrimiento.`);
    else o.source = a;
  }
  return o;
}

// ── Textos propios de la API en dos idiomas (5.6), como la referencia ────────
const LANGUAGES = ['en', 'es'];
const t = (en, es) => ({ en, es });
const text = (v, lang) => (typeof v === 'string' ? v : v[lang]);
const RANGE = /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i;
function pickLanguage(header) {
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
      if (LANGUAGES.includes(tag)) return tag;
      const cut = tag.lastIndexOf('-');
      tag = cut < 0 ? '' : tag.slice(0, cut).replace(/-[a-z0-9]$/, '');
    }
  }
  return LANGUAGES[0];
}

// Etiqueta de idioma bien formada en minúsculas (RFC 5646, 2.1), como en la referencia.
const TAG = new RegExp('^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?' +
  '(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?' +
  '|x(?:-[a-z0-9]{1,8})+|en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)' +
  '|sgn-(?:be-fr|be-nl|ch-de)|art-lojban|cel-gaulish|no-bok|no-nyn|zh-(?:guoyu|hakka|min|min-nan|xiang))$');

// ── Utilidades ────────────────────────────────────────────────────────────────
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const etag = (value) => `"${hash(JSON.stringify(value))}"`;
const ptr = (f) => `/${f.replace(/~/g, '~0').replace(/\//g, '~1')}`;
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v));
const warnings = [];
const warn = (msg) => warnings.push(msg);

// Generador pseudoaleatorio determinista: cada (semilla, colección, elemento, campo) tiene su propio flujo,
// así que añadir un campo al descubrimiento no cambia los valores de los demás.
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

// ── Cargar el descubrimiento ──────────────────────────────────────────────────
const isUrl = (s) => /^https?:\/\//i.test(s);
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`No se puede conectar con ${url}: ${e.cause?.code ?? e.message}`);
  }
  if (!res.ok) throw new Error(`${url} responde ${res.status}.`);
  try { return { json: await res.json(), res }; } catch { throw new Error(`${url} no devuelve JSON.`); }
}
async function loadDiscovery(source) {
  let doc, base;
  if (isUrl(source)) {
    let { json, res } = await fetchJson(source);
    if (!isObject(json) || typeof json.restep !== 'string') {
      // 4.2: el documento puede estar en otra ruta, enlazada con rel="service-desc".
      const links = [...(res.headers.get('link') ?? '').matchAll(/<([^>]+)>\s*;[^,]*rel="?service-desc"?/g)].map((m) => new URL(m[1], source).href);
      for (const l of links) {
        const r = await fetchJson(l).catch(() => null);
        if (r && isObject(r.json) && typeof r.json.restep === 'string') { json = r.json; source = l; break; }
      }
    }
    doc = json; base = source;
  } else {
    let raw;
    try { raw = readFileSync(source, 'utf8'); } catch (e) { throw new Error(`No se puede leer ${source}: ${e.code ?? e.message}`); }
    try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${source} no es JSON válido: ${e.message}`); }
    base = resolve(source);
  }
  if (!isObject(doc) || typeof doc.restep !== 'string')
    throw new Error(`${source} no es un documento de descubrimiento de Restep: le falta el miembro "restep" (4.2).`);
  const v = RESTEP_VERSION.exec(doc.restep);
  if (!v || v[1] !== '1') throw new Error(`restep-mock solo entiende Restep 1 (mayor.menor[-draft.N|-rc.N], 1.1), y el documento dice ${JSON.stringify(doc.restep)}.`);
  // Esquemas enlazados (4.3): se leen para generar y validar, y se sirven en la misma ruta.
  const linked = {};
  const actionInputs = (c) => Object.entries(isObject(c?.actions) ? c.actions : {}).map(([a, d]) => [`input de la acción ${a}`, d?.input]);
  for (const [name, c] of [...Object.entries(doc.collections ?? {}), ...Object.entries(isObject(doc.singletons) ? doc.singletons : {})]) {
    for (const [kind, s] of [...Object.entries(isObject(c?.schemas) ? c.schemas : {}), ...actionInputs(c)]) {
      if (typeof s !== 'string' || Object.hasOwn(linked, s)) continue;
      try {
        if (isUrl(base)) linked[s] = (await fetchJson(new URL(s, base).href)).json;
        else if (isUrl(s)) linked[s] = (await fetchJson(s)).json;
        else linked[s] = JSON.parse(readFileSync(resolve(dirname(base), `.${s.startsWith('/') ? s : `/${s}`}`), 'utf8'));
      } catch (e) {
        // El de un input lo avisa la acción, que dice qué hace sin él.
        if (!kind.startsWith('input')) warn(`No se ha podido leer el esquema ${kind} de ${name} (${s}): ${e.message}. Se usan los tipos del descubrimiento.`);
      }
    }
  }
  return { doc, linked };
}

// ── Modelo de cada colección ──────────────────────────────────────────────────
const DECIMAL = /^-?\d+(\.\d+)?$/;
const looksDecimal = (pattern) => typeof pattern === 'string' && /(\\d|\[0-9\])\+\s*\(\s*\\\.\s*(\\d|\[0-9\])\+\s*\)\?/.test(pattern);
// Quita el null de anyOf/oneOf/type: devuelve [esquema sin null, admite null].
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
  return undefined;
}
// Sin esquema ni filtro que lo diga, el tipo sale del nombre del campo.
function typeFromName(f) {
  if (/(_at|_time|timestamp)$/.test(f)) return 'datetime';
  if (/(^date$|_date$|_on$|^birthday$)/.test(f)) return 'date';
  if (/(duration|_length$)/.test(f)) return 'duration';
  if (/^(is|has|can)_|^(active|enabled|published|available|visible|archived)$/.test(f)) return 'boolean';
  if (/(price|amount|cost|total|balance|fee|subtotal|tax_rate|vat)/.test(f)) return 'decimal';
  if (/(^year$|count$|_count|quantity|^qty$|stock|^age$|_seconds$|^pages$)/.test(f)) return 'integer';
  if (/(rating|score|^lat|^lng|^lon|latitude|longitude|weight|height)/.test(f)) return 'number';
  return 'string';
}

// ── Subcolecciones (4.2, 5.1) ─────────────────────────────────────────────────
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
// 5.1: la ruta de un elemento es la de su colección, con la plantilla rellena con los id de sus padres, / y su id.
function itemPath(coll, key, id) {
  const ids = key ? key.split('/') : [];
  let k = 0;
  return `/${coll.segs.map((x) => (isVar(x) ? ids[k++] : x)).join('/')}${id === undefined ? '' : `/${id}`}`;
}
const childKey = (key, id) => (key ? `${key}/${id}` : id);
// Una colección vista en un ámbito (los elementos bajo un padre): hereda todo y cambia rows, used y path.
function view(coll, key = '') {
  const v = Object.create(coll);
  v.rows = scope(coll, key); v.used = usedOf(coll, key); v.key = key; v.path = itemPath(coll, key);
  return v;
}
// Qué es una ruta, en segmentos ya descodificados: { coll, key, id }. Gana la plantilla con más literales y,
// a igualdad, la colección sobre el elemento.
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
// Si existe el elemento padre de un ámbito (y, por tanto, toda la cadena: borrar un padre borra sus ámbitos).
function parentExists(db, coll, key) {
  if (!coll.parent) return true;
  const ids = key.split('/');
  return db[coll.parent].scopes.get(ids.slice(0, -1).join('/'))?.has(ids.at(-1)) ?? false;
}
// Un href (ruta absoluta o URI): { coll, key, id, row } si es la ruta de un elemento simulado.
function parseHref(db, href) {
  if (typeof href !== 'string') return null;
  let segments;
  try { segments = new URL(href, 'http://localhost').pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  const m = match(db, segments);
  return m && m.id !== undefined ? { ...m, row: m.coll.scopes.get(m.key)?.get(m.id) } : null;
}

function buildModel(doc, linked) {
  const profiles = (Array.isArray(doc.profiles) ? doc.profiles : ['core']).filter((p) => typeof p === 'string');
  const unsupportedProfiles = profiles.filter((p) => !SUPPORTED_PROFILES.includes(p));
  const extensions = (Array.isArray(doc.extensions) ? doc.extensions : []).filter((x) => typeof x === 'string');
  if (unsupportedProfiles.length) warn(`No se implementa ${unsupportedProfiles.join(', ')}: se quita de profiles en el descubrimiento servido.`);
  const dropped = extensions.filter((x) => !SUPPORTED_EXTENSIONS.includes(x));
  if (dropped.length) warn(`No se implementa ${dropped.join(', ')}: se quita de extensions en el descubrimiento servido.`);
  const active = profiles.filter((p) => SUPPORTED_PROFILES.includes(p));
  if (!active.includes('core')) active.unshift('core');
  // 5.5: un aviso profile vencido retira el perfil, y con él los que lo necesitan (1.2).
  const now = Date.now();
  const due = (d) => isObject(d) && typeof d.sunset === 'string' && Date.parse(d.sunset) <= now;
  for (const d of Array.isArray(doc.deprecations) ? doc.deprecations : []) {
    if (!due(d) || d.kind !== 'profile' || !active.includes(d.name)) continue;
    warn(`El perfil ${d.name} se retiró el ${d.sunset}: no se anuncia.`);
    active.splice(active.indexOf(d.name), 1);
  }
  const has = (p) => active.includes(p);
  const served = structuredClone({ ...doc, restep: RESTEP, profiles: active, extensions: [] });
  if (doc.restep !== RESTEP) warn(`El documento declara "restep": ${JSON.stringify(doc.restep)}; el mock implementa el borrador 6 y sirve "${RESTEP}".`);
  for (const k of ['batch', 'events']) if (k in served) { delete served[k]; }
  // 7.1: anonymous solo puede ser false (se rechazan claves sin credenciales) o faltar.
  if (isObject(served.idempotency) && served.idempotency.anonymous !== undefined && served.idempotency.anonymous !== false) delete served.idempotency.anonymous;
  served.collections = {};
  const db = {};
  for (const [name, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string' || !c.path.startsWith('/')) { warn(`La colección ${name} no tiene un path válido: se omite.`); continue; }
    const path = c.path.replace(/\/+$/, '') || '/';
    if (path === '/') { warn(`La colección ${name} está en la raíz: se omite.`); continue; }
    const schemaOf = (k) => { const s = c.schemas?.[k]; return typeof s === 'string' ? linked[s] : s; };
    const item = schemaOf('item'), create = schemaOf('create'), update = schemaOf('update');
    const props = { ...(isObject(create?.properties) ? create.properties : {}), ...(isObject(item?.properties) ? item.properties : {}) };
    const filter = isObject(c.filter) ? c.filter : {};
    const relations = {};
    for (const [r, d] of Object.entries(isObject(c.relations) ? c.relations : {})) {
      if (!isObject(d) || d.to === undefined) continue;
      relations[r] = { to: d.to, many: d.many === true, include: d.include === true, path: typeof d.path === 'string' ? d.path : undefined };
    }
    const mapsDecl = isObject(c.language_maps) ? Object.keys(c.language_maps) : [];
    const inherit = {};
    for (const [f, d] of Object.entries(isObject(c.inherit) ? c.inherit : {})) {
      if (isObject(d) && typeof d.own === 'string' && Array.isArray(d.from)) inherit[f] = { own: d.own, from: d.from, default: d.default === true };
    }
    // Campos: los del esquema, y si no hay, todos los que nombra el descubrimiento.
    const names = new Set(['id', ...Object.keys(props)]);
    if (!item) {
      for (const f of Object.keys(filter)) if (!f.includes('.')) names.add(f);
      for (const s of Array.isArray(c.sort) ? c.sort : []) if (typeof s === 'string' && !s.includes('.')) names.add(s);
      for (const f of mapsDecl) names.add(f);
      for (const f of Object.keys(relations)) names.add(f);
      for (const [f, d] of Object.entries(inherit)) { names.add(f); names.add(d.own); }
      for (const f of Object.keys(filter)) if (f.includes('.') && !mapsDecl.includes(f.split('.')[0])) names.add(f.split('.')[0]);
    }
    const types = {}, values = {}, nullable = {}, constraints = {};
    for (const f of names) {
      const [s, isNull] = unwrap(props[f]);
      nullable[f] = isNull;
      constraints[f] = s;
      let type = f === 'id' ? 'string'
        : mapsDecl.includes(f) ? 'map'
        : relations[f] ? 'relation'
        : filter[f]?.type ?? typeFromSchema(s);
      // El tipo efectivo y el propio de una herencia son el mismo.
      if (!type) {
        const pair = Object.entries(inherit).find(([e, d]) => e === f || d.own === f);
        if (pair) type = filter[pair[0]]?.type ?? filter[pair[1].own]?.type ?? typeFromSchema(unwrap(props[pair[0]])[0]) ?? typeFromSchema(unwrap(props[pair[1].own])[0]);
      }
      if (!type && f.includes('.')) continue;
      types[f] = type ?? typeFromName(f);
      if (types[f] === 'enum') values[f] = filter[f]?.values ?? s.enum ?? ['a', 'b', 'c'];
      if (relations[f] && relations[f].many === false && (s.type === 'array' || s.items)) relations[f].many = true;
    }
    for (const [f, d] of Object.entries(inherit)) {
      if (!types[f] || !types[d.own]) { warn(`${name}.inherit.${f}: faltan ${f} o ${d.own}; se ignora la herencia.`); delete inherit[f]; continue; }
      types[d.own] = types[f]; if (types[f] === 'enum') values[d.own] = values[f];
    }
    for (const f of mapsDecl) if (!types[f]) types[f] = 'map';
    for (const r of Object.keys(relations)) if (!types[r]) types[r] = 'relation';
    let required = Array.isArray(create?.required) ? create.required.filter((f) => f in types && f !== 'id')
      : Array.isArray(item?.required) ? item.required.filter((f) => f in types && f !== 'id') : [];
    // 4.3: un default en una propiedad de primer nivel de create es el valor de un campo que el POST no trae.
    const createDefaults = Object.fromEntries(Object.entries(isObject(create?.properties) ? create.properties : {})
      .filter(([f, d]) => f in types && f !== 'id' && isObject(d) && Object.hasOwn(d, 'default')).map(([f, d]) => [f, structuredClone(d.default)]));
    const methods = Array.isArray(c.methods) ? [...c.methods] : ['GET', 'POST'];
    const itemMethods = Array.isArray(c.item_methods) ? [...c.item_methods] : ['GET', 'PATCH', 'DELETE'];
    // 5.1: quién elige el id. Un valor que el borrador 6 no define no se simula.
    let idFrom = c.id_from ?? 'server';
    if (!['server', 'client', 'either'].includes(idFrom)) { warn(`${name}.id_from ${JSON.stringify(c.id_from)} no se simula: se sirve sin él (lo elige el servidor).`); idFrom = 'server'; }
    // 6.1: colaciones. "codepoint" es lo de siempre; cualquier otro valor se compara como "server" (sin
    // mayúsculas ni acentos), que es lo que un cliente tiene que suponer de un valor que no conoce.
    const collations = Object.fromEntries(Object.entries(isObject(c.collations) ? c.collations : {}).filter(([, v]) => v !== 'codepoint'));
    // 5.1: campos de solo lectura, los que el esquema item marca readOnly en sus properties (id y los efectivos van aparte).
    const readOnly = Object.entries(isObject(item?.properties) ? item.properties : {})
      .filter(([f, d]) => f !== 'id' && isObject(d) && d.readOnly === true && !inherit[f] && f in types).map(([f]) => f);
    const idSchema = isObject(create?.properties?.id) ? create.properties.id : {};
    db[name] = {
      name, path, description: c.description, methods, item_methods: itemMethods, types, values, nullable, constraints, required,
      idFrom, collations, readOnly, idPattern: typeof idSchema.pattern === 'string' ? idSchema.pattern : null,
      // 4.2: una subcolección tiene una plantilla en path y su parent; sus elementos van por ámbitos, uno por
      // cada elemento padre (la clave es la lista de id de los padres, separados por /).
      segs: segsOf(path), parent: typeof c.parent === 'string' ? c.parent : undefined, scopes: new Map(), usedByKey: new Map(),
      actions: {},
      filter: Object.fromEntries(Object.entries(filter).filter(([, d]) => isObject(d) && Array.isArray(d.ops)).map(([f, d]) => [f, d])),
      // 6.1: filtros con nombre. Su significado está solo en la descripción, así que el mock elige
      // de forma determinista una parte de los elementos para cada nombre y valor.
      named: has('query') && isObject(c.named_filters)
        ? Object.fromEntries(Object.entries(c.named_filters).filter(([f, d]) => isObject(d) && !f.includes('.') && !Object.hasOwn(filter, f))
          .map(([f, d]) => [f, { type: typeof d.type === 'string' ? d.type : null, values: Array.isArray(d.values) ? d.values : null }]))
        : {},
      // 6.2: solo las claves declaradas; sin sort declarado, sort=id da unsupported_parameter. El orden por
      // defecto (5.2) es por id igualmente.
      sort: has('query') && Array.isArray(c.sort) ? [...c.sort] : [],
      // 6.4: limit solo se acepta donde se declara max_limit; sin él, las páginas son de 20.
      max_limit: Number.isInteger(c.max_limit) && c.max_limit > 0 ? c.max_limit : null,
      count: has('query') && (c.count === 'exact' || c.count === 'estimated') ? c.count : null,
      relations, inherit, includeDepth: Number.isInteger(c.include_depth) ? c.include_depth : 1,
      closedUpdate: isObject(update) && update.additionalProperties === false,
      tags: {}, defaults: {}, createDefaults, nextId: 1,
    };
    if (!db[name].parent && !/[{}]/.test(path)) { db[name].rows = scope(db[name], ''); db[name].used = usedOf(db[name], ''); }
    const out = structuredClone(c);
    delete out.sync;
    if ('sync' in c) warn(`${name}: no se implementa sync; se quita del descubrimiento servido.`);
    // 11.1: acciones. Cada una con on, safe e idempotent; GET solo si es segura y entonces sin input; ninguna se
    // llama changes. Lo que no encaja (o un on o un method que el borrador 6 no define) no se sirve.
    if (isObject(c.actions)) {
      out.actions = {};
      for (const [a, d] of Object.entries(c.actions)) {
        const method = d?.method ?? 'POST';
        const why = !isObject(d) ? 'no es un objeto' : !NAME.test(a) ? 'su nombre no sigue la gramática de §3' : a === 'changes' ? 'changes es de sync'
          : !['item', 'collection'].includes(d.on) ? `on ${JSON.stringify(d.on)}` : typeof d.safe !== 'boolean' || typeof d.idempotent !== 'boolean' ? 'le falta safe o idempotent'
          : !['GET', 'POST'].includes(method) ? `method ${JSON.stringify(method)}` : method === 'GET' && !d.safe ? 'GET en una acción que no es segura'
          : method === 'GET' && d.input !== undefined ? 'GET con input' : null;
        if (why) { warn(`${name}:${a}: ${why}; no se simula ni se sirve.`); continue; }
        const input = typeof d.input === 'string' ? linked[d.input] : d.input;
        if (typeof d.input === 'string' && !input) warn(`${name}:${a}: no se ha podido leer su input (${d.input}); se acepta cualquier objeto.`);
        db[name].actions[a] = { on: d.on, safe: d.safe, idempotent: d.idempotent, method, input: isObject(input) ? input : null };
        out.actions[a] = structuredClone(d);
      }
      if (!Object.keys(out.actions).length) delete out.actions;
    }
    if (c.id_from !== undefined && idFrom === 'server' && c.id_from !== 'server') delete out.id_from;
    served.collections[name] = out;
  }
  // 4.2: cada subcolección nombra en parent la colección de la que cuelga, y su path es el de esa colección,
  // /, una variable propia y lo que siga sin más variables. Las variables tienen nombres distintos. Lo que no
  // encaja (o cuelga de algo que no se simula) se omite, y con ello sus descendientes.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, coll] of Object.entries(db)) {
      const vars = coll.segs.filter(isVar), names = vars.map((v) => v.slice(1, -1));
      const P = coll.parent !== undefined ? db[coll.parent] : null;
      const at = P ? P.segs.length : 0;
      const why = new Set(names).size !== names.length ? 'tiene variables repetidas'
        : !vars.length ? (coll.parent !== undefined ? 'declara parent pero su path no tiene plantilla' : null)
        : coll.parent === undefined ? 'tiene plantilla pero no parent'
        : !P ? `cuelga de ${coll.parent}, que no se simula`
        : P.segs.filter(isVar).length !== vars.length - 1 || !P.segs.every((x, i) => coll.segs[i] === x) || !isVar(coll.segs[at])
          || coll.segs.length === at + 1 || coll.segs.slice(at + 1).some(isVar) ? `su path no es el de ${coll.parent} seguido de /{variable}/…` : null;
      if (!why) continue;
      warn(`La subcolección ${name} (${coll.path}) ${why}: se omite.`);
      delete db[name]; delete served.collections[name]; changed = true;
    }
  }
  for (const coll of Object.values(db)) {
    coll.ancestors = [];
    for (let p = coll.parent; p; p = db[p].parent) coll.ancestors.unshift(p);
  }
  // 6.1: no se declaran en filter ni en sort las rutas que pasan por una relación a muchos ni las que acaban en
  // el id de una relación cuyo destino es una subcolección (ese id solo identifica bajo su padre).
  for (const [name, coll] of Object.entries(db)) {
    const out = served.collections[name];
    const forbidden = (k) => {
      const [head, next] = k.split('.');
      const d = coll.relations[head];
      if (k.indexOf('.') < 0 || !d) return false;
      return d.many || (next === 'id' && [].concat(d.to).some((to) => db[to]?.parent));
    };
    for (const k of Object.keys(coll.filter)) if (forbidden(k)) { warn(`${name}: filter[${k}] pasa por una relación a muchos o acaba en el id de un elemento de una subcolección (6.1): no se sirve.`); delete coll.filter[k]; delete out.filter?.[k]; }
    for (const k of [...coll.sort]) if (forbidden(k)) { warn(`${name}: sort ${k} no se puede declarar (6.1): no se sirve.`); coll.sort.splice(coll.sort.indexOf(k), 1); out.sort?.splice(out.sort.indexOf(k), 1); }
    // 9: una relación a muchos cuyo path es la plantilla de una subcolección de esta colección lleva a ella. No se
    // incrusta en la representación (para eso está la subcolección); con include, si es expandible, trae sus
    // elementos bajo ese padre. No se escribe.
    for (const [r, d] of Object.entries(coll.relations)) {
      const sub = typeof d.to === 'string' ? db[d.to] : null;
      const shape = (segs) => segs.map((x) => (isVar(x) ? '{}' : x)).join('/');
      if (d.many && sub?.parent === name && typeof d.path === 'string' && shape(segsOf(d.path)) === shape(sub.segs)) d.derived = d.to;
    }
  }
  // 11.1 y 11.6: se anuncian las extensiones que se simulan y que alguna colección usa.
  const inherits = Object.values(db).some((c) => Object.keys(c.inherit).length);
  const acts = Object.values(db).some((c) => Object.keys(c.actions).length);
  served.extensions = [...(acts ? ['actions'] : []), ...(inherits ? ['inherit'] : [])];
  if (acts && !extensions.includes('actions')) warn('Hay colecciones con actions pero extensions no anuncia actions: se anuncia en el descubrimiento servido.');
  if (inherits && !extensions.includes('inherit')) warn('Hay colecciones con inherit pero extensions no anuncia inherit (11.6): se anuncia en el descubrimiento servido.');
  for (const [name, c] of Object.entries(served.collections)) if (!Object.keys(db[name].inherit).length) delete c.inherit;

  // 5.9: singletons. Uno con plantilla o con parent se ignora (es una forma reservada para versiones menores).
  const singletons = {};
  served.singletons = {};
  for (const [name, c] of Object.entries(isObject(doc.singletons) ? doc.singletons : {})) {
    if (!isObject(c) || typeof c.path !== 'string' || !c.path.startsWith('/') || /[{}]/.test(c.path) || c.parent !== undefined) {
      warn(`El singleton ${name} tiene una plantilla, parent o un path no válido: se omite.`); continue;
    }
    const path = c.path.replace(/\/+$/, '');
    if (Object.values(db).some((x) => path === x.path || path.startsWith(`${x.path}/`))) { warn(`El singleton ${name} (${path}) choca con una colección: se omite.`); continue; }
    const schemaOf = (k) => { const s = c.schemas?.[k]; return typeof s === 'string' ? linked[s] : s; };
    const item = schemaOf('item'), update = schemaOf('update');
    const props = { ...(isObject(update?.properties) ? update.properties : {}), ...(isObject(item?.properties) ? item.properties : {}) };
    const types = {}, values = {}, nullable = {}, constraints = {};
    for (const [f, d] of Object.entries(props)) {
      const [sch, isNull] = unwrap(d);
      const type = typeFromSchema(sch) ?? typeFromName(f);
      if (type === 'relation' || type === 'map') { warn(`${name}.${f}: el mock no simula relaciones ni mapas de idioma en un singleton; se omite el campo.`); continue; }
      types[f] = type; nullable[f] = isNull; constraints[f] = sch;
      if (type === 'enum') values[f] = sch.enum ?? ['a', 'b', 'c'];
    }
    const methods = (Array.isArray(c.methods) ? c.methods : ['GET']).filter((m) => m === 'GET' || m === 'PATCH');
    if (!methods.includes('GET')) methods.unshift('GET');
    const readOnly = Object.entries(isObject(item?.properties) ? item.properties : {}).filter(([f, d]) => f in types && isObject(d) && d.readOnly === true).map(([f]) => f);
    if ('id' in types && !readOnly.includes('id')) readOnly.push('id'); // 5.9: el id de un singleton es de solo lectura
    singletons[name] = { name, path, methods, types, values, nullable, constraints, readOnly, singleton: true,
      required: Array.isArray(item?.required) ? item.required.filter((f) => f in types) : [], relations: {}, inherit: {}, tags: {},
      closedUpdate: isObject(update) && update.additionalProperties === false, row: {} };
    served.singletons[name] = structuredClone(c);
  }
  if (!Object.keys(served.singletons).length && !isObject(doc.singletons)) delete served.singletons;

  // 5.5: avisos de retirada. Cada kind en su sitio; uno que no va donde está no se sirve. Pasada su fecha,
  // la retirada se aplica (RETIRES) o el aviso no se sirve.
  const notices = [];
  const takeNotices = (list, scope, owner, setList) => {
    const kept = [];
    for (const d of Array.isArray(list) ? list : []) {
      if (!isObject(d) || !KINDS[scope].includes(d.kind)) { warn(`Aviso de retirada con kind ${JSON.stringify(d?.kind)} fuera de su sitio (${scope}${owner ? ` ${owner}` : ''}): no se sirve.`); continue; }
      if (due(d) && d.kind === 'profile') continue; // ya aplicado arriba
      if (due(d) && !RETIRES.includes(d.kind)) { warn(`El aviso ${d.kind} ${d.name ?? ''} venció el ${d.sunset} y el mock no simula esa retirada: no se sirve.`); continue; }
      kept.push(d);
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
        warn(`${coll.name}.${r} apunta a ${targets.join(', ')}, que no se simula: sus enlaces quedan a null.`);
        d.missing = true;
      }
    }
    // Etiquetas de cada mapa de idioma: las que el descubrimiento usa en filter y sort, más en y es.
    for (const f of Object.keys(coll.types).filter((x) => coll.types[x] === 'map')) {
      const tags = new Set(['en', 'es']);
      for (const k of [...Object.keys(coll.filter), ...coll.sort.map((s) => s.replace(/^-/, ''))])
        if (k.startsWith(`${f}.`) && TAG.test(k.slice(f.length + 1))) tags.add(k.slice(f.length + 1));
      coll.tags[f] = [...tags];
    }
  }
  return { db, singletons, served, profiles: active, has, notices };
}

// 5.5: lo que pasa tras el sunset de un aviso que el mock sabe simular. Lo retirado deja de estar declarado
// y se comporta como lo que nunca se declaró (unsupported_parameter, 405), salvo una colección o un
// singleton enteros, que dan 410 retired.
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

// ── Generación de datos plausibles ────────────────────────────────────────────
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
  else if (/(description|summary|bio|notes|comment|body|text|content)/.test(f)) v = rng.pick(SENTENCES)[1];
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
      // Los registros (created_at…) a cualquier segundo del día; las citas, en horario y en cuartos de hora.
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
    default: return genString(f, rng, i, s, coll.name);
  }
}
function genMap(coll, f, rng) {
  const noun = rng.pick(NOUNS), adj = rng.pick(ADJS), sentence = rng.pick(SENTENCES);
  const long = /(description|summary|text|body|notes)/.test(f);
  const out = {};
  for (const tag of coll.tags[f]) {
    if (tag !== 'en' && rng.chance(0.3)) continue; // faltan traducciones a propósito: no hay idioma de reserva (6.1)
    const es = tag === 'es' || tag.startsWith('es-');
    out[tag] = long ? sentence[es ? 1 : 0] : es ? `${noun[1]} ${adj[1]}` : `${capital(adj[0])} ${noun[0].toLowerCase()}`;
  }
  if (rng.chance(0.08)) return {}; // alguno sin ninguna traducción
  return out;
}
// Un enlace a un elemento de target en el ámbito key: { id }, con type si la relación va a varias colecciones
// y con href si target es una subcolección (3: su id solo lo identifica bajo su padre).
const linkTo = (target, key, id, poly) => ({ id, ...(poly && { type: target.name }), ...(target.parent && { href: itemPath(target, key, id) }) });
function genRelation(db, coll, f, rng, i, key = '') {
  const d = coll.relations[f];
  if (d.missing) return d.many ? [] : null;
  // Los padres del elemento que enlaza, y él mismo: { colección: id }. Un enlace a una subcolección que cuelga de
  // alguno de ellos se queda bajo el mismo padre (el destacado de un libro es una reseña de ese libro, no de otro).
  const mine = Object.fromEntries([...coll.ancestors, coll.name].map((n, j) => [n, [...(key ? key.split('/') : []), String(i + 1)][j]]));
  const sameParents = (target, k) => { const ids = k ? k.split('/') : []; return target.ancestors.every((n, j) => !(n in mine) || mine[n] === ids[j]); };
  const pickOne = () => {
    const to = [].concat(d.to), name = rng.pick(to), target = db[name];
    // A la misma colección (y al mismo ámbito) solo enlaza con elementos anteriores, para no crear ciclos.
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
function generate(model, seed, counts, defaultCount) {
  const { db } = model;
  // Primero los padres y las colecciones de las que dependen otras, para que los enlaces apunten a algo.
  const order = [], state = {};
  const visit = (name) => {
    if (state[name]) return;
    state[name] = 1;
    if (db[name].parent) visit(db[name].parent);
    // Los enlaces a elementos de una subcolección se rellenan al final (abajo): esa subcolección puede
    // colgar de esta misma colección (books → highlight → /books/{book_id}/reviews).
    for (const d of Object.values(db[name].relations)) for (const to of [].concat(d.to)) if (db[to] && to !== name && !d.derived && !db[to].parent) visit(to);
    order.push(name);
  };
  Object.keys(db).forEach(visit);
  const later = []; // [coll, key, row, campo, i]: enlaces a subcolecciones, para cuando existan sus elementos
  for (const name of order) {
    const coll = db[name];
    // Una subcolección: n elementos bajo cada elemento padre (por defecto 3, o --count nombre=n).
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
          if (f === 'id' || coll.inherit[f]) continue;
          const rng = key ? rngFor(seed, name, key, i, f) : rngFor(seed, name, i, f);
          if (type === 'map') { row[f] = genMap(coll, f, rng); continue; }
          if (type === 'relation') {
            const d = coll.relations[f];
            if (d.derived) continue;
            if ([].concat(d.to).some((to) => db[to]?.parent)) later.push([coll, key, row, f, i]);
            else row[f] = genRelation(db, coll, f, rng, i, key);
            continue;
          }
          if (owns.has(f)) { // el propio de una herencia: casi siempre hereda, si tiene de quién
            const rule = Object.values(coll.inherit).find((d) => d.own === f);
            const canInherit = rule.from.some((r) => coll.relations[r]) || rule.default;
            row[f] = canInherit && rng.chance(0.65) ? null : genScalar(coll, f, type, rng, i);
            continue;
          }
          if (!coll.required.includes(f) && !/^(name|title|email|username)$/.test(f) && rng.chance(0.1)) { row[f] = null; continue; } // algunos sin valor: el operador null tiene qué encontrar
          row[f] = genScalar(coll, f, type, rng, i);
        }
        rows.set(row.id, row);
        used.add(row.id); // 5.1: un id que la colección (bajo ese padre) ha tenido no se vuelve a dar
      }
    }
    coll.nextId = n + 1;
    delete coll._created;
  }
  for (const [coll, key, row, f, i] of later) row[f] = genRelation(db, coll, f, key ? rngFor(seed, coll.name, key, i, f) : rngFor(seed, coll.name, i, f), i, key);
  // 5.9: cada singleton es un objeto con los campos de su esquema.
  for (const sg of Object.values(model.singletons ?? {})) {
    sg.row = {};
    for (const [f, type] of Object.entries(sg.types)) {
      const rng = rngFor(seed, 'singleton', sg.name, f);
      if (!sg.required.includes(f) && sg.nullable[f] && rng.chance(0.1)) { sg.row[f] = null; continue; }
      sg.row[f] = genScalar(sg, f, type, rng, 0);
    }
  }
  refresh(db);
}

// ── Valores heredados (11.6), generalizados desde la referencia ───────────────
// El elemento al que apunta un enlace: [colección, fila o undefined, clave del ámbito]. Un elemento de una
// subcolección se busca por su href, que tiene que ser la ruta de un elemento de esa colección con ese id.
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
  if (row[rule.own] != null) return { value: row[rule.own], href: itemPath(coll, key, row.id) };
  for (const r of rule.from) {
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
          if (s.value === undefined) delete row[f]; else row[f] = s.value;
          if (row[coll.inherit[f].own] == null) why[f] = { from: s.href ? { href: s.href } : 'default' };
        }
      }
      const all = { ...row };
      for (const k of Object.keys(row)) delete row[k];
      for (const k of Object.keys(coll.types)) if (k in all) row[k] = all[k];
      if (inherits) row._inherited = why;
    }
  }
}

// ── Comparación con tipo (6.1) ────────────────────────────────────────────────
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
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const validDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
// Instante con precisión de nanosegundos: [milisegundos, fracción por debajo del milisegundo].
function instant(s) {
  const frac = /\.(\d+)/.exec(s)?.[1] ?? '';
  return [Date.parse(s.replace(/\.\d+/, '')) + Number(frac.slice(0, 3).padEnd(3, '0')), Number(frac.slice(3, 9).padEnd(6, '0'))];
}
function seconds(d) { // longitud de una duración: un día son 24 horas; años y meses, aproximados (solo en datos guardados)
  const m = DURATION.exec(d);
  if (!m) return NaN;
  const n = (x) => Number.parseFloat(x ?? '0');
  return n(m[1]) * 365 * 86400 + n(m[2]) * 30 * 86400 + n(m[3]) * 7 * 86400 + n(m[4]) * 86400 + n(m[6]) * 3600 + n(m[7]) * 60 + n(m[8]);
}
// 6.1: "server", la colación del mock para los campos que la declaran: sin mayúsculas ni acentos. La igualdad
// y el orden coinciden (iguales si ninguno va antes), y el desempate por id lo pone el orden.
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function compare(type, a, b, collation) {
  if (collation && (type === 'string' || type === 'enum')) return cmpText(fold(String(a)), fold(String(b)));
  if (type === 'decimal') return cmpDecimal(String(a), String(b));
  if (type === 'integer' || type === 'number') return a - b;
  if (type === 'boolean') return Number(a) - Number(b);
  if (type === 'datetime') { const [x, xn] = instant(a), [y, yn] = instant(b); return x - y || xn - yn; }
  if (type === 'duration') return seconds(a) - seconds(b);
  return cmpText(String(a), String(b));
}

// ── Validación con JSON Schema (4.3), lo común: lo que usan los input de las acciones ──
// Devuelve una entrada { pointer, code } por fallo, con los códigos de 5.4. No sigue $ref ni allOf.
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
    if ((s.format === 'date' && !validDate(v)) || (s.format === 'date-time' && !DATETIME.test(v)) || (s.format === 'duration' && !DURATION.test(v)))
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

// ── El servidor ───────────────────────────────────────────────────────────────
class Problem extends Error {
  constructor(status, code, detail, extra = {}, headers = {}) { super(text(detail, 'en')); Object.assign(this, { status, code, detail, extra, headers }); }
}
const TITLES = {
  400: t('Bad request', 'Petición incorrecta'), 404: t('Not found', 'No encontrado'), 405: t('Method not allowed', 'Método no permitido'),
  409: t('Conflict', 'Conflicto'), 410: t('Gone', 'Ya no existe'),
  412: t('The resource has changed', 'El recurso ha cambiado'), 415: t('Unsupported media type', 'Tipo de contenido no admitido'),
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
// 8: grupos de caché (RFC 9875) como lista de cadenas de Structured Fields; la colección, primero.
const groups = (paths) => [...new Set(paths)].slice(0, 32).map((g) => `"${g.replace(/[\\"]/g, '\\$&')}"`).join(', ');

export function createMock(model, options = {}) {
  const { db, served, profiles, has } = model;
  // 8: Cache-Groups y Cache-Group-Invalidation son del perfil cache; sin él no se envían.
  const cacheGroups = (name, paths) => (has('cache') ? { [name]: groups(paths) } : {});
  const link = `<${PROFILE}>; rel="profile"`; // 4.1: un único enlace, a la URI de la versión
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

  // Ruta con punto: una traducción (name.es-mx), un campo de una relación (author.id, author.name).
  function at(coll, row, f) {
    if (row == null) return undefined;
    const dot = f.indexOf('.');
    if (dot < 0) return row[f];
    const head = f.slice(0, dot), rest = f.slice(dot + 1);
    if (coll.types[head] === 'map') return row[head]?.[rest];
    if (coll.types[head] === 'relation') {
      const v = row[head];
      if (!isObject(v)) return undefined;
      if (rest === 'id' || rest === 'type') return v[rest];
      const found = targetOf(db, coll, head, v);
      return found && found[1] ? at(found[0], found[1], rest) : undefined;
    }
    return undefined;
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
    return coll.types[f] === 'enum' ? coll.values[f] : coll.types[f] ?? 'string';
  }
  function parseValue(type, raw, key) {
    const fail = (what) => { throw bad(key, t(`${raw} is not a valid ${what}.`, `${raw} no es un ${what} válido.`)); };
    if (Array.isArray(type)) {
      if (type.includes(raw)) return raw;
      throw bad(key, t(`${raw} is not one of: ${type.join(', ')}.`, `${raw} no es ninguno de: ${type.join(', ')}.`));
    }
    switch (type) {
      case 'decimal': return DECIMAL.test(raw) ? raw : fail('decimal');
      case 'integer': return /^-?\d+$/.test(raw) ? Number(raw) : fail('integer');
      case 'number': return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw) ? Number(raw) : fail('number');
      case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : fail('boolean (true or false)');
      case 'date': return validDate(raw) ? raw : fail('date (YYYY-MM-DD)');
      case 'datetime': return DATETIME.test(raw) && !Number.isNaN(Date.parse(raw.replace(/\.\d+/, ''))) ? raw : fail('RFC 3339 date-time with offset');
      case 'duration': {
        const m = DURATION.exec(raw);
        if (!m) fail('ISO 8601 duration');
        if (m[1] || m[2]) throw bad(key, t('Years and months have no fixed length: use days, hours, minutes or seconds.',
          'Los años y los meses no tienen una longitud fija: usa días, horas, minutos o segundos.'));
        return raw;
      }
      default: return raw;
    }
  }
  const MAX_IN = 500;
  const OPS = { eq: (c) => c === 0, ne: (c) => c !== 0, lt: (c) => c < 0, le: (c) => c <= 0, gt: (c) => c > 0, ge: (c) => c >= 0 };
  const SAME_FILTER = t('The same filter appears twice.', 'El mismo filtro aparece dos veces.');
  function applyFilters(coll, params) {
    let items = [...coll.rows.values()];
    const seen = new Set();
    for (const [key, value] of params) {
      if (reservedName(key) !== 'filter') continue;
      if (key === 'filter') throw unsupported(key, t('filter as an expression needs the filter-expr extension.', 'filter como expresión necesita la extensión filter-expr.'));
      const m = key.match(/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/);
      if (!m) throw unsupported(key, t('This resource supports filter[field] and filter[field][op].', 'Este recurso admite filter[campo] y filter[campo][op].'));
      const [, field, op = 'eq'] = m;
      if (Object.hasOwn(coll.named, field)) {
        const n = coll.named[field];
        if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));
        if (!n.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));
        if (n.type && value === '') throw bad(key, t(`${field} needs a ${n.type} value.`, `${field} necesita un valor ${n.type}.`));
        if (n.type) parseValue(n.type === 'enum' ? n.values ?? [] : n.type, value, key);
        items = items.filter((r) => parseInt(hash(`${field}=${value}:${r.id}`).slice(0, 8), 16) % 2 === 0);
        continue;
      }
      if (!Object.hasOwn(coll.filter, field)) throw unsupported(key, t(`${field} cannot be filtered. Filterable: ${Object.keys(coll.filter).join(', ') || 'none'}.`, `${field} no se puede filtrar. Se puede por: ${Object.keys(coll.filter).join(', ') || 'ninguno'}.`));
      if (!coll.filter[field].ops.includes(op)) throw unsupported(key, t(`${field} supports: ${coll.filter[field].ops.join(', ')}.`, `${field} admite: ${coll.filter[field].ops.join(', ')}.`));
      if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);
      seen.add(`${field}[${op}]`);
      const type = typeOf(coll, field);
      const collation = coll.collations[field];
      const get = (r) => at(coll, r, field);
      if (op === 'null') {
        if (value !== 'true' && value !== 'false') throw bad(key, t('Use true or false.', 'Usa true o false.'));
        items = items.filter((r) => (get(r) == null) === (value === 'true'));
      } else if (op === 'in') {
        // 6.1: filter[f][in]= es una lista vacía; un elemento vacío entre comas es la cadena vacía.
        if (value === '') throw bad(key, t('in needs a non-empty, comma-separated list.', 'in necesita una lista no vacía, separada por comas.'));
        const values = value.split(',');
        // 5.3: un límite que no se declara; pasarlo da invalid_parameter, nunca parte del resultado.
        if (values.length > MAX_IN) throw bad(key, t(`in takes at most ${MAX_IN} values.`, `in admite como mucho ${MAX_IN} valores.`));
        const parsed = values.map((v) => parseValue(type, v, key));
        const ty = Array.isArray(type) ? 'enum' : type;
        items = items.filter((r) => get(r) != null && parsed.some((v) => compare(ty, get(r), v, collation) === 0));
      } else {
        const v = parseValue(type, value, key), ty = Array.isArray(type) ? 'enum' : type;
        items = items.filter((r) => get(r) != null && OPS[op](compare(ty, get(r), v, collation)));
      }
    }
    return items;
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
  function expand(coll, row, paths) {
    if (!paths.length) return row;
    const out = { ...row };
    const byRel = {};
    for (const p of paths) { const [h, ...rest] = p.split('.'); (byRel[h] ??= []).push(...(rest.length ? [rest.join('.')] : [])); }
    for (const [r, sub] of Object.entries(byRel)) {
      const one = (link) => {
        const found = targetOf(db, coll, r, link);
        if (!found || !found[1]) return link;
        const full = expand(found[0].parent ? view(found[0], found[2]) : found[0], found[1], sub);
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
        // 6.3: el campo del elemento incluido tiene que existir (si la relación va a una sola colección).
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
  function list(coll, params, path) {
    let items = applyFilters(coll, params);
    const sort = parseSort(coll, params);
    items.sort((a, b) => {
      for (const s of [...sort, 'id']) {
        const f = s.replace(/^-/, '');
        const x = at(coll, a, f), y = at(coll, b, f);
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
    const print = queryPrint(path, params);
    const offset = readCursor(params, print);
    const count = params.get('count');
    if (count !== null && !coll.count) throw unsupported('count'); // 6.5: con cualquier valor, false incluido
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
    // Recuento «estimated»: se redondea a la decena, como haría un servidor que estima.
    const total = coll.count === 'estimated' ? Math.round(items.length / 10) * 10 : items.length;
    return {
      // 7.2: un elemento que admite PATCH o DELETE lleva en _etag la ETag de su GET (de la fila entera).
      items: page.map((r) => (writable ? { ...pick(expand(coll, r, include), fields), _etag: etag(r) } : pick(expand(coll, r, include), fields))), next,
      ...(count === 'true' && { total }),
      ...(count === 'true' && coll.count === 'estimated' && { total_estimated: true }),
    };
  }

  // ── Escrituras ──
  // 3: el tipo de medio se compara sin mayúsculas; charset solo puede ser utf-8 (con o sin comillas) y los
  // demás parámetros se ignoran. Un cuerpo sin Content-Type, también vacío, da 415.
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
    let v;
    try { v = JSON.parse(raw); } catch {}
    if (isObject(v)) return [Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_'))), v];
    throw new Problem(400, 'bad_request', t('The body is not a valid JSON object.', 'El cuerpo no es un objeto JSON válido.'));
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
    if (type === 'datetime') return DATETIME.test(v) && !Number.isNaN(Date.parse(v.replace(/\.\d+/, '')));
    if (type === 'duration') return DURATION.test(v);
    return true;
  }
  function validate(coll, row, label, errors = []) {
    for (const f of coll.required) if (row[f] === undefined || row[f] === null) errors.push({ pointer: ptr(f), code: 'required', detail: t(`${f} is required.`, `${f} es obligatorio.`) });
    for (const [f, v] of Object.entries(row)) {
      if (f.startsWith('_')) continue;
      if (!Object.hasOwn(coll.types, f)) { errors.push({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) }); continue; }
      const type = coll.types[f];
      if (v === null || f === 'id' || type === 'map' || type === 'relation') continue;
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
      // Restricciones del esquema declarado (4.3), las más comunes.
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
    : typeof a === 'string' && typeof b === 'string' && DECIMAL.test(a) && DECIMAL.test(b) ? cmpDecimal(a, b) === 0 : a === b);
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
  // 5.1: una relación a un elemento que no existe da unknown en su id; una con su valor actual se ignora sin
  // buscarla, así que devolver una representación tal como se leyó nunca falla por ella.
  const linkIds = (v) => [].concat(v ?? []).map((o) => (isObject(o) ? `${o.type ?? ''}/${o.id}/${o.href ?? ''}` : JSON.stringify(o))).join(',');
  // Los elementos de la subcolección a la que lleva una relación, bajo un elemento: [{ id, href }].
  function children(coll, row, r) {
    const sub = db[coll.relations[r].derived], k = childKey(coll.key ?? '', row?.id);
    return row ? [...(sub?.scopes.get(k)?.values() ?? [])].map((x) => linkTo(sub, k, x.id, false)) : [];
  }
  function relationErrors(coll, body, id, current) {
    const errors = [];
    for (const [r, d] of Object.entries(coll.relations)) {
      if (!(r in body)) continue;
      const now = d.derived ? children(coll, current, r) : current ? current[r] ?? (d.many ? [] : null) : d.many ? [] : null;
      // 9: la relación que lleva a una subcolección no se escribe: con su valor actual se ignora; con otro, read_only.
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
        // 5.1: a un elemento de una subcolección se enlaza con su href tal como se leyó; uno que no es la ruta
        // de un elemento de esa colección, o cuyo último segmento no es el id enviado, da 422.
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
  // Borrar un elemento quita los enlaces que apuntaban a él (por id o, en una subcolección, por href) y borra sus
  // subcolecciones enteras: una subcolección existe mientras exista su elemento padre (5.1).
  function unlink(coll, id, key = '') {
    const gone = [[coll, key, id]];
    const prefix = childKey(key, id);
    for (const sub of Object.values(db)) {
      if (!sub.ancestors.includes(coll.name)) continue;
      for (const k of [...sub.scopes.keys()]) {
        if (k !== prefix && !k.startsWith(`${prefix}/`)) continue;
        for (const r of sub.scopes.get(k).keys()) gone.push([sub, k, r]);
        sub.scopes.delete(k); // sus id siguen en usedByKey: no se vuelven a dar
      }
    }
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
  // 7.1: una Structured Fields String sin parámetros, de un principal y un destino (método y ruta, sin la
  // query). Sin credenciales, todas las peticiones son un mismo principal anónimo; con "anonymous": false,
  // su clave se rechaza con 400 antes de cualquier efecto.
  const anonymousRefused = isObject(served.idempotency) && served.idempotency.anonymous === false;
  function idempotencyScope(req, path) {
    if (!has('writes')) return null; // 7.1: un servidor solo core no conoce la cabecera
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
  // 5.1: quién elige el id. Uno del cliente sigue §3 y, si el esquema create lo dice, su pattern.
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
  // 5.1: un campo de solo lectura con su valor actual se ignora; con otro, read_only. En un POST, el valor que
  // el elemento recibiría es ninguno: solo se ignora null.
  function readOnlyErrors(coll, body, current) {
    const errors = [];
    for (const f of coll.readOnly) {
      if (!(f in body)) continue;
      if (current ? canonical(body[f]) === canonical(current[f] ?? null) || same(body[f], current[f]) : body[f] === null) { delete body[f]; continue; }
      errors.push({ pointer: ptr(f), code: 'read_only', detail: t(`${f} is read-only.`, `${f} es de solo lectura.`) });
      delete body[f];
    }
    return errors;
  }

  // ── Retiradas (5.5) ──
  // Las cabeceras de una respuesta que usa algo avisado en deprecations y aún no retirado: Deprecation con
  // el instante del aviso, un Link rel="deprecation" a la explicación y, si se retira un recurso entero o la
  // versión, Sunset.
  const notices = (model.notices ?? []).filter((n) => !n.due);
  const epoch = (d) => { const ms = Date.parse(d.announced ?? ''); return `@${Math.floor((Number.isNaN(ms) ? Date.now() : ms) / 1000)}`; };
  function deprecationHeaders(ctx, data) {
    const p = ctx.params ?? new URLSearchParams();
    const filters = [...p.keys()].map((k) => ({ k, m: /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(k) })).filter((x) => x.m);
    const sorts = (p.get('sort') ?? '').split(',').filter(Boolean).map((x) => x.replace(/^-/, ''));
    const includes = (p.get('include') ?? '').split(',').filter(Boolean);
    const fields = (p.get('fields') ?? '').split(',').filter(Boolean);
    const named = [...filters.map((x) => x.m[1]), ...sorts, ...includes, ...fields];
    const covers = (name, x) => x === name || x.startsWith(`${name}.`);
    const rows = data === undefined ? [] : Array.isArray(data?.items) ? data.items : [data];
    const used = notices.filter((n) => {
      switch (n.scope === 'root' ? `root:${n.kind}` : n.kind) {
        case 'root:version': case 'root:profile': case 'root:extension': return true;
        case 'root:collection': return ctx.coll?.name === n.name;
        case 'root:singleton': return ctx.sg?.name === n.name;
        case 'root:reason': return false; // el mock no da razones
        default: break;
      }
      const mine = n.scope === 'collection' ? ctx.coll?.name === n.owner : ctx.sg?.name === n.owner;
      if (!mine) return false;
      switch (n.kind) {
        case 'field': return named.some((x) => covers(n.name, x)) || rows.some((r) => isObject(r) && n.name in r);
        case 'filter': return filters.some((x) => x.m[1] === n.name);
        case 'operator': return filters.some((x) => x.m[1] === n.name && (x.m[2] ?? 'eq') === n.op);
        case 'value': return filters.some((x) => x.m[1] === n.name && ['eq', 'ne', 'in'].includes(x.m[2] ?? 'eq') && p.getAll(x.k).some((v) => v.split(',').includes(String(n.value))));
        case 'sort': return sorts.includes(n.name);
        case 'relation': return includes.some((x) => covers(n.name, x)) || named.some((x) => x.startsWith(`${n.name}.`));
        case 'include': return includes.some((x) => covers(n.name, x));
        case 'count': return p.has('count');
        case 'max_limit': return Number.isInteger(n.value) && /^\d+$/.test(p.get('limit') ?? '') && Number(p.get('limit')) > n.value;
        case 'method': return n.scope === 'singleton' ? ctx.method === n.name : !ctx.item && ctx.method === n.name;
        case 'item_method': return ctx.item && ctx.method === n.name;
        case 'action': return ctx.action === n.name;
        default: return false;
      }
    });
    if (!used.length) return {};
    const whole = used.find((n) => ((n.scope === 'root' && ['version', 'collection', 'singleton'].includes(n.kind)) || n.kind === 'action') && typeof n.sunset === 'string');
    return { Deprecation: epoch(used[0]), Link: `${link}, <${SPEC}#versions>; rel="deprecation"`,
      ...(whole && { Sunset: new Date(whole.sunset).toUTCString() }) };
  }
  const retired = (when) => new Problem(410, 'retired', t(`Retired on ${when}.`, `Retirado el ${when}.`));

  // ── Encaminamiento ──
  const ONLY_READ = t('Only GET and HEAD.', 'Solo GET y HEAD.');
  const missing = (url) => new Problem(404, 'not_found', t(`${url.pathname} does not exist.`, `${url.pathname} no existe.`));
  const discoveryTag = etag(served);
  const singletonByPath = new Map(Object.values(model.singletons ?? {}).map((sg) => [sg.path, sg]));
  // 7.2: toda respuesta cuyo cuerpo es un elemento lleva su ETag de elemento en _etag (con writes).
  const withEtag = (row) => (has('writes') ? { ...row, _etag: etag(row) } : row);
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
    if (Object.hasOwn(schemaPaths, url.pathname)) { // esquemas enlazados desde el descubrimiento (4.3)
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
    // 3: cada segmento de la ruta se compara tras descodificarlo, así que /books/%37 es /books/7.
    let segments;
    try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw missing(url); }
    const path = `/${segments.join('/')}`;
    const sg = singletonByPath.get(path);
    if (sg) return handleSingleton(sg, req, res, params, url);
    // 11.1: el nombre de una acción va tras dos puntos en el último segmento (también como %3A).
    const last = segments.at(-1) ?? '', colon = last.indexOf(':');
    const actionName = colon >= 0 ? last.slice(colon + 1) : undefined;
    if (colon >= 0) segments[segments.length - 1] = last.slice(0, colon);
    // La colección (o la subcolección, con los id de sus padres) cuya plantilla encaja con la ruta.
    const found = match(db, segments);
    if (!found || (found.id !== undefined && (found.id.includes(':') || !found.id))) throw missing(url);
    const base = found.coll, id = found.id;
    // 5.1: una ruta bajo un padre que no existe no existe.
    if (!parentExists(db, base, found.key)) throw missing(url);
    const coll = view(base, found.key);
    req.extra = deprecationHeaders({ coll, item: id !== undefined, method, params, action: actionName });
    if (id !== undefined && !coll.rows.has(id) && !base.retired) throw missing(url);
    if (base.retired) throw retired(base.retired); // 5.5: tras su sunset, 410 retired
    if (actionName !== undefined) return handleAction(coll, id, actionName, req, res, params);

    // 4.3: HEAD va con GET (5.1); sin GET declarado, HEAD también da 405 y Allow no lo lista.
    const declared = id === undefined ? coll.methods : coll.item_methods;
    const methods = declared.includes('GET') ? [...declared, 'HEAD'] : [...declared];
    if (!methods.includes(method))
      throw new Problem(405, 'method_not_allowed', t(`Supports ${methods.join(', ')}.`, `Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') });

    // 5.3: lo que el recurso implementa con este método; limit solo con max_limit declarado (6.4).
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

    if (read) {
      let data, tag;
      if (id === undefined) { data = list(coll, params, coll.path); tag = etag(data); }
      else {
        const row = coll.rows.get(id);
        const include = has('relations') ? parseInclude(coll, params) : [];
        const fields = has('query') ? parseFields(params, coll, include) : null;
        // 7.2: con fields o include es otra representación, con su propia ETag; _etag sigue siendo la del elemento.
        data = fields || include.length ? { ...pick(expand(coll, row, include), fields), ...(has('writes') && { _etag: etag(row) }) } : withEtag(row);
        tag = fields || include.length ? etag(data) : etag(row);
      }
      const members = id === undefined ? data.items.map((r) => location(r)) : [location(data)];
      const headers = { ETag: tag, 'Cache-Control': 'no-cache', ...cacheGroups('Cache-Groups', id === undefined ? [coll.path, ...members] : members),
        ...deprecationHeaders({ coll, item: id !== undefined, method, params }, data) };
      const itemTag = id === undefined ? tag : etag(coll.rows.get(id));
      if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], itemTag))
        throw new Problem(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
      if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);
      return send(res, 200, data, headers, method === 'HEAD');
    }

    if (id === undefined) { // POST
      const scope = idempotencyScope(req, path);
      const [body, sent] = await readJson(req, ['application/json']);
      // 7.1: la misma petición es la misma clave, principal, destino, query y cuerpo (como valores JSON).
      const query = [...params].map(([k, v]) => `${k}=${v}`).sort();
      const print = scope && hash(canonical([query, sent]));
      const saved = scope && idempotency.get(scope);
      const live = saved && saved.expires > Date.now() ? saved : null;
      if (live && live.print === print) return send(res, ...live.response.slice(0, 2), { ...live.response[2], 'Idempotent-Replayed': 'true' });
      const collTag = etag(list(coll, new URLSearchParams(), coll.path));
      if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], collTag))
        throw new Problem(412, 'precondition_failed', t('If-Match does not match the current collection.', 'If-Match no coincide con la colección actual.'));
      if (weakMatch(req.headers['if-none-match'], collTag))
        throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current collection.', 'If-None-Match coincide con la colección actual.'));
      if (live) throw new Problem(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
      const errors = [...idErrors(coll, body), ...readOnlyErrors(coll, body)];
      // 4.3: los campos que no vienen toman su default; uno enviado como null sí viene.
      for (const [f, v] of Object.entries(coll.createDefaults)) if (!Object.hasOwn(body, f)) body[f] = structuredClone(v);
      const chosen = 'id' in body && !errors.length ? body.id : undefined;
      delete body.id;
      validate(coll, body, undefined, [...errors, ...languageErrors(coll, body), ...relationErrors(coll, body), ...inheritErrors(coll, body)]);
      // 5.1 y 5.4: un id que la colección tiene o ha tenido da 409 conflict con taken, después de los 422.
      if (chosen !== undefined && coll.used.has(chosen))
        throw new Problem(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'), { errors: [{ pointer: '/id', code: 'taken', detail: t('An item of this collection has or had this id.', 'Un ítem de esta colección tiene o tuvo este id.') }] });
      let newId = chosen;
      if (newId === undefined) { while (coll.used.has(String(coll.nextId))) coll.nextId++; newId = String(coll.nextId++); }
      const row = withMaps(coll, { ...body, id: newId });
      coll.rows.set(row.id, row);
      coll.used.add(row.id);
      refresh(db);
      const stored = coll.rows.get(row.id);
      const response = [201, prefer ? undefined : withEtag(structuredClone(stored)), { Location: location(stored), ETag: etag(stored),
        ...cacheGroups('Cache-Group-Invalidation', [coll.path, location(stored)]), ...applied, ...req.extra }];
      if (scope) idempotency.set(scope, { print, response, expires: Date.now() + TTL });
      return send(res, ...response);
    }

    const [patch] = method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']) : [null];
    const current = coll.rows.get(id);
    if (!current) throw missing(url); // 7.2: un elemento borrado entretanto da 404, digan lo que digan las precondiciones
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
    if (weakMatch(req.headers['if-none-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current item.', 'If-None-Match coincide con el ítem actual.'));
    const invalidation = { ...cacheGroups('Cache-Group-Invalidation', [coll.path, `${coll.path}/${id}`]), ...req.extra };
    if (method === 'DELETE') { unlink(coll, id, coll.key); coll.rows.delete(id); return send(res, 204, undefined, invalidation); }
    if ('id' in patch && patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.', 'id no puede cambiar.') }]);
    const unknown = Object.keys(patch).filter((f) => !f.startsWith('_') && !Object.hasOwn(coll.types, f));
    if (unknown.length) throw invalid(unknown.map((f) => ({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) })));
    const errors = [...readOnlyErrors(coll, patch, current), ...languageErrors(coll, patch, current)];
    errors.push(...relationErrors(coll, patch, id, current), ...inheritErrors(coll, patch, current));
    // 5.1: una relación se sustituye entera, no se fusiona.
    const relValues = Object.fromEntries(Object.keys(coll.relations).filter((r) => patch[r] != null).map((r) => [r, patch[r]]));
    const row = withMaps(coll, { ...mergePatch(current, patch), ...relValues, id });
    validate(coll, row, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'), errors);
    coll.rows.set(id, row);
    refresh(db);
    const stored = coll.rows.get(id);
    return send(res, prefer ? 204 : 200, prefer ? undefined : withEtag(stored), { ETag: etag(stored), ...invalidation, ...applied });
  }

  // 11.1: una acción simulada. El mock no conoce su lógica, así que no cambia ningún dato: comprueba lo que el
  // texto define (que esté declarada en ese tipo de recurso, el método, el cuerpo frente a su input, la clave
  // de idempotencia y las precondiciones) y responde con la representación del recurso afectado (200): el
  // elemento, o la primera página de la colección si es una acción segura de colección. Una acción de
  // colección que no es segura responde 204, sin cuerpo; una de elemento con return=minimal, también.
  async function handleAction(coll, id, name, req, res, params) {
    const method = req.method;
    const a = coll.actions[name];
    // Una acción que la colección no declara, o que se declara sobre el otro tipo de recurso, no existe.
    if (!a || a.on !== (id === undefined ? 'collection' : 'item')) throw new Problem(404, 'not_found', t(`There is no action ${name} here.`, `Aquí no hay ninguna acción ${name}.`));
    if (a.retired) throw retired(a.retired);
    const allow = a.method === 'GET' ? ['GET', 'HEAD'] : ['POST'];
    if (!allow.includes(method)) throw new Problem(405, 'method_not_allowed', t(`Supports ${allow.join(', ')}.`, `Admite ${allow.join(', ')}.`), {}, { Allow: allow.join(', ') });
    // 5.3: una acción no implementa ningún parámetro reservado.
    for (const key of new Set(params.keys())) if (isReserved(reservedName(key))) throw unsupported(key);
    const path = `${coll.path}${id === undefined ? '' : `/${id}`}:${name}`;
    const row = id === undefined ? null : coll.rows.get(id);
    const answer = () => (id === undefined ? list(coll, new URLSearchParams(), coll.path) : withEtag(row));
    if (a.method === 'GET') {
      const data = answer();
      return send(res, 200, data, { 'Cache-Control': 'no-cache', ...(row && { ETag: etag(row) }), ...req.extra }, method === 'HEAD');
    }
    // 7.1 y 11.1: una acción no idempotente admite Idempotency-Key (mal formada, o sin credenciales con
    // "anonymous": false, da 400); una idempotente no la rechaza nunca: la ignora y no guarda nada.
    const scope = a.idempotent ? null : idempotencyScope(req, path);
    const [body, sent] = await readActionBody(req);
    const query = [...params].map(([k, v]) => `${k}=${v}`).sort();
    const print = scope && hash(canonical([query, sent]));
    const saved = scope && idempotency.get(scope);
    const live = saved && saved.expires > Date.now() ? saved : null;
    if (live && live.print === print) return send(res, ...live.response.slice(0, 2), { ...live.response[2], 'Idempotent-Replayed': 'true' });
    // 7.2: el destino de una acción de elemento es el elemento; el de una de colección, la colección.
    const target = row ? etag(row) : etag(list(coll, new URLSearchParams(), coll.path));
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], target))
      throw new Problem(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
    if (weakMatch(req.headers['if-none-match'], target))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current representation.', 'If-None-Match coincide con la representación actual.'));
    if (live) throw new Problem(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
    // 4.3: el cuerpo frente al esquema input, quitados antes los miembros que empiezan por _.
    if (a.input) {
      const errors = jsonErrors(a.input, body);
      if (errors.length) throw invalid(errors.map((e) => ({ ...e, detail: t(`${e.pointer || 'The body'} does not fit the input schema (${e.code}).`, `${e.pointer || 'El cuerpo'} no encaja con el esquema input (${e.code}).`) })));
    }
    const prefer = /(^|[ ,;])return=minimal\b/.test(req.headers.prefer ?? '');
    const response = row && !prefer
      ? [200, answer(), { ETag: etag(row), ...req.extra }]
      : [204, undefined, { ...(row && { ETag: etag(row), 'Preference-Applied': 'return=minimal' }), ...req.extra }];
    if (scope) idempotency.set(scope, { print, response, expires: Date.now() + TTL });
    return send(res, ...response);
  }
  // 11.1: un cuerpo vacío, con o sin Content-Type, es {} como application/json; uno que no lo está sigue §3.
  async function readActionBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (raw === '') return [{}, {}];
    if (!mediaTypeOk(req.headers['content-type'], ['application/json']))
      throw new Problem(415, 'unsupported_media_type', t('Send application/json, in UTF-8, or an empty body.', 'Envía application/json, en UTF-8, o un cuerpo vacío.'));
    let v;
    try { v = JSON.parse(raw); } catch {}
    if (!isObject(v)) throw new Problem(400, 'bad_request', t('The body is not a valid JSON object.', 'El cuerpo no es un objeto JSON válido.'));
    return [Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_'))), v];
  }

  // 5.9: un singleton se comporta como un elemento sin id ni colección. GET (y HEAD) y, si se declara, PATCH;
  // POST y DELETE dan 405. Con query, fields; cualquier otro parámetro reservado, unsupported_parameter.
  async function handleSingleton(sg, req, res, params, url) {
    const method = req.method, read = method === 'GET' || method === 'HEAD';
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
      const data = fields ? { ...pick(sg.row, fields), ...(has('writes') && { _etag: etag(sg.row) }) } : withEtag(sg.row);
      if (!('id' in sg.row)) delete data.id;
      const headers = { ETag: fields ? etag(data) : etag(sg.row), 'Cache-Control': 'no-cache', ...cacheGroups('Cache-Groups', [sg.path]),
        ...deprecationHeaders({ sg, method, params }, data) };
      if (weakMatch(req.headers['if-none-match'], headers.ETag)) return send(res, 304, undefined, headers);
      return send(res, 200, data, headers, method === 'HEAD');
    }
    const [patch] = await readJson(req, ['application/merge-patch+json', 'application/json']);
    const current = sg.row;
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
    if (weakMatch(req.headers['if-none-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current representation.', 'If-None-Match coincide con la representación actual.'));
    const unknown = Object.keys(patch).filter((f) => !f.startsWith('_') && !Object.hasOwn(sg.types, f));
    if (unknown.length) throw invalid(unknown.map((f) => ({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) })));
    const errors = readOnlyErrors(sg, patch, current);
    const merged = mergePatch(current, patch);
    const row = Object.fromEntries(Object.keys(sg.types).filter((f) => f in merged).map((f) => [f, merged[f]])); // siempre en el mismo orden, para la ETag
    validate(sg, row, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'), errors);
    sg.row = row;
    return send(res, prefer ? 204 : 200, prefer ? undefined : withEtag(row), { ETag: etag(row), ...cacheGroups('Cache-Group-Invalidation', [sg.path]), ...req.extra,
      ...(prefer && { 'Preference-Applied': 'return=minimal' }) });
  }

  // Latencia y fallos simulados: deterministas por semilla, en el orden en que llegan las peticiones.
  const chaos = rngFor(seed, 'chaos');
  const [lo, hi] = options.latency ?? [0, 0];
  const failRate = options.failRate ?? 0;
  return createServer(async (req, res) => {
    const delay = lo + Math.floor(chaos() * (hi - lo + 1));
    const fail = failRate > 0 && chaos() < failRate;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const url = new URL(req.url, 'http://localhost');
    // El estado del servicio (4.4) no se cae con la API simulada: así se distingue un fallo transitorio.
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

// ── Programa ──────────────────────────────────────────────────────────────────
export async function prepare(source, { seed = 1, count = 50, counts = {} } = {}) {
  const { doc, linked } = await loadDiscovery(source);
  const model = buildModel(doc, linked);
  generate(model, seed, counts, count);
  // Los esquemas enlazados con ruta absoluta se sirven en la misma ruta.
  const served = Object.fromEntries(Object.entries(linked).filter(([k]) => k.startsWith('/')));
  return { model, linked: served };
}
// Los datos generados: una lista por colección; una subcolección, una lista por cada ruta de colección.
export const dumpData = (model) => Object.fromEntries(Object.entries(model.db).map(([n, c]) => [n, c.parent
  ? Object.fromEntries([...c.scopes].map(([k, rows]) => [itemPath(c, k), [...rows.values()]]))
  : [...c.rows.values()]]));

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`restep-mock: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  if (!o.source) { console.error('restep-mock: falta el documento de descubrimiento (un archivo JSON o una URL). Mira --help.'); process.exit(2); }
  let prepared;
  try { prepared = await prepare(o.source, o); } catch (e) { console.error(`restep-mock: ${e.message}`); process.exit(2); }
  const { model, linked } = prepared;
  if (!o.quiet) for (const w of warnings) console.error(`aviso: ${w}`);
  if (o.dump) { process.stdout.write(`${JSON.stringify(dumpData(model), null, 2)}\n`); return; }
  for (const c of Object.keys(o.counts)) if (!model.db[c]) console.error(`aviso: --count ${c}=… no corresponde a ninguna colección simulada.`);
  const server = createMock(model, { seed: o.seed, latency: o.latency, failRate: o.failRate, retryAfter: o.retryAfter, linked });
  server.on('error', (e) => { console.error(`restep-mock: no se puede escuchar en el puerto ${o.port}: ${e.code ?? e.message}`); process.exit(2); });
  server.listen(o.port, o.host, () => {
    const { port } = server.address();
    const sizes = Object.values(model.db).map((c) => `${c.name} (${[...entries(c)].length})`).join(', ');
    console.log(`restep-mock ${VERSION} · Restep 1 (${model.profiles.join(', ')}) en http://localhost:${port}/`);
    console.log(`Colecciones: ${sizes || 'ninguna'} · semilla ${o.seed}` +
      `${o.latency[1] ? ` · latencia ${o.latency[0]}-${o.latency[1]} ms` : ''}${o.failRate ? ` · fallos ${o.failRate * 100} %` : ''}`);
  });
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const invoked = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) main();
