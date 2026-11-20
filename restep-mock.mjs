#!/usr/bin/env node
// restep-mock · API Restep 1 falsa a partir de un documento de descubrimiento.
// Node 18 o posterior, sin dependencias.
//   npx restep-mock <discovery.json | URL> [--port N] [--seed N] [--count 50] [--latency 0-300] [--fail-rate 0.05]
// Genera datos plausibles y deterministas (por semilla) según el tipo y el nombre de cada campo, y se
// comporta como un servidor real de los perfiles core, query, writes y relations: filtros, orden, fields,
// paginación con cursores firmados, recuento, errores problem+json, parámetros reservados que fallan en
// voz alta, escrituras en memoria con Idempotency-Key, ETag/If-Match/If-None-Match, mapas de idioma y
// valores heredados (5.7). Gran parte del código viene del servidor de referencia (vendor/restep-server.mjs).
// Lo que no implementa (sync, extensiones, subcolecciones, retiradas) lo quita del descubrimiento que
// sirve y lo avisa por la salida de errores, para no anunciar nada que no cumple.
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const VERSION = '0.1.0';
const SPEC = 'https://restep.wubytes.com/1/';
const SUPPORTED_PROFILES = ['core', 'query', 'writes', 'relations'];

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
  if (!/^1\.\d+$/.test(doc.restep)) throw new Error(`restep-mock solo entiende Restep 1.x, y el documento dice ${JSON.stringify(doc.restep)}.`);
  // Esquemas enlazados (4.3): se leen para generar y validar, y se sirven en la misma ruta.
  const linked = {};
  for (const [name, c] of Object.entries(doc.collections ?? {})) {
    for (const [kind, s] of Object.entries(isObject(c?.schemas) ? c.schemas : {})) {
      if (typeof s !== 'string') continue;
      try {
        if (isUrl(base)) linked[s] = (await fetchJson(new URL(s, base).href)).json;
        else if (isUrl(s)) linked[s] = (await fetchJson(s)).json;
        else linked[s] = JSON.parse(readFileSync(resolve(dirname(base), `.${s.startsWith('/') ? s : `/${s}`}`), 'utf8'));
      } catch (e) {
        warn(`No se ha podido leer el esquema ${kind} de ${name} (${s}): ${e.message}. Se usan los tipos del descubrimiento.`);
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

function buildModel(doc, linked) {
  const profiles = (Array.isArray(doc.profiles) ? doc.profiles : ['core']).filter((p) => typeof p === 'string');
  const unsupportedProfiles = profiles.filter((p) => !SUPPORTED_PROFILES.includes(p));
  const extensions = Array.isArray(doc.extensions) ? doc.extensions : [];
  if (unsupportedProfiles.length) warn(`No se implementa ${unsupportedProfiles.join(', ')}: se quita de profiles en el descubrimiento servido.`);
  if (extensions.length) warn(`No se implementa ninguna extensión (${extensions.join(', ')}): se quitan del descubrimiento servido.`);
  const active = profiles.filter((p) => SUPPORTED_PROFILES.includes(p));
  if (!active.includes('core')) active.unshift('core');
  const has = (p) => active.includes(p);
  const served = { ...doc, profiles: active, extensions: [] };
  for (const k of ['batch', 'events']) if (k in served) { delete served[k]; }
  if (Array.isArray(doc.deprecations) && doc.deprecations.length) {
    warn('No se simulan las retiradas (5.5): se quita deprecations del descubrimiento servido.');
    delete served.deprecations;
  }
  served.collections = {};
  const db = {};
  for (const [name, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string' || !c.path.startsWith('/')) { warn(`La colección ${name} no tiene un path válido: se omite.`); continue; }
    if (/[{}]/.test(c.path)) { warn(`${name} es una subcolección (${c.path}): restep-mock aún no las simula y la omite.`); continue; }
    const path = c.path.replace(/\/+$/, '') || '/';
    if (path === '/') { warn(`La colección ${name} está en la raíz: se omite.`); continue; }
    const schemaOf = (k) => { const s = c.schemas?.[k]; return typeof s === 'string' ? linked[s] : s; };
    const item = schemaOf('item'), create = schemaOf('create'), update = schemaOf('update');
    const props = { ...(isObject(create?.properties) ? create.properties : {}), ...(isObject(item?.properties) ? item.properties : {}) };
    const filter = isObject(c.filter) ? c.filter : {};
    const relations = {};
    for (const [r, d] of Object.entries(isObject(c.relations) ? c.relations : {})) {
      if (!isObject(d) || d.to === undefined) continue;
      relations[r] = { to: d.to, many: d.many === true, include: d.include === true };
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
    const methods = Array.isArray(c.methods) ? c.methods : ['GET', 'POST'];
    const itemMethods = Array.isArray(c.item_methods) ? c.item_methods : ['GET', 'PATCH', 'DELETE'];
    db[name] = {
      name, path, description: c.description, methods, item_methods: itemMethods, types, values, nullable, constraints, required,
      filter: Object.fromEntries(Object.entries(filter).filter(([, d]) => isObject(d) && Array.isArray(d.ops)).map(([f, d]) => [f, d])),
      sort: has('query') && Array.isArray(c.sort) ? c.sort : ['id'],
      max_limit: Number.isInteger(c.max_limit) && c.max_limit > 0 ? c.max_limit : 100,
      count: has('query') && (c.count === 'exact' || c.count === 'estimated') ? c.count : null,
      relations, inherit, includeDepth: Number.isInteger(c.include_depth) ? c.include_depth : 1,
      closedUpdate: isObject(update) && update.additionalProperties === false,
      tags: {}, defaults: {}, rows: new Map(), nextId: 1,
    };
    const out = { ...c };
    for (const k of ['sync', 'actions']) delete out[k];
    if ('sync' in c) warn(`${name}: no se implementa sync; se quita del descubrimiento servido.`);
    if ('actions' in c) warn(`${name}: no se implementa actions; se quita del descubrimiento servido.`);
    served.collections[name] = out;
  }
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
  return { db, served, profiles: active, has };
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
      let [min, max] = /^year$/.test(f) ? [1950, 2026] : /^age$/.test(f) ? [18, 90] : /(stock|quantity|qty|count)/.test(f) ? [0, 200]
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
function genRelation(db, coll, f, rng, i) {
  const d = coll.relations[f];
  if (d.missing) return d.many ? [] : null;
  const pickOne = () => {
    const to = [].concat(d.to), name = rng.pick(to), target = db[name];
    // A la misma colección solo enlaza con elementos anteriores, para no crear ciclos.
    const ids = [...target.rows.keys()].filter((id) => target !== coll || Number(id) < i + 1);
    if (!ids.length) return null;
    const id = rng.pick(ids);
    return to.length > 1 ? { id, type: name } : { id };
  };
  if (d.many) {
    const n = rng.int(0, 3), seen = new Set(), out = [];
    for (let k = 0; k < n; k++) { const o = pickOne(); if (o && !seen.has(o.id)) { seen.add(o.id); out.push(o); } }
    return out;
  }
  const required = coll.required.includes(f);
  if (!required && (rng.chance(0.1) || (db[[].concat(d.to)[0]] === coll && rng.chance(0.4)))) return null;
  return pickOne();
}
function generate(model, seed, counts, defaultCount) {
  const { db } = model;
  // Primero las colecciones de las que dependen otras, para que los enlaces apunten a algo.
  const order = [], state = {};
  const visit = (name) => {
    if (state[name]) return;
    state[name] = 1;
    for (const d of Object.values(db[name].relations)) for (const to of [].concat(d.to)) if (db[to] && to !== name) visit(to);
    order.push(name);
  };
  Object.keys(db).forEach(visit);
  for (const name of order) {
    const coll = db[name], n = counts[name] ?? defaultCount;
    const owns = new Set(Object.values(coll.inherit).map((d) => d.own));
    for (const [f, d] of Object.entries(coll.inherit))
      coll.defaults[f] = d.default ? genScalar(coll, f, coll.types[f], rngFor(seed, name, 'default', f), 0) : undefined;
    for (let i = 0; i < n; i++) {
      const row = { id: String(i + 1) };
      coll._created = undefined;
      for (const [f, type] of Object.entries(coll.types)) {
        if (f === 'id' || coll.inherit[f]) continue;
        const rng = rngFor(seed, name, i, f);
        if (type === 'map') { row[f] = genMap(coll, f, rng); continue; }
        if (type === 'relation') { row[f] = genRelation(db, coll, f, rng, i); continue; }
        if (owns.has(f)) { // el propio de una herencia: casi siempre hereda, si tiene de quién
          const rule = Object.values(coll.inherit).find((d) => d.own === f);
          const canInherit = rule.from.some((r) => coll.relations[r]) || rule.default;
          row[f] = canInherit && rng.chance(0.65) ? null : genScalar(coll, f, type, rng, i);
          continue;
        }
        if (!coll.required.includes(f) && !/^(name|title|email|username)$/.test(f) && rng.chance(0.1)) { row[f] = null; continue; } // algunos sin valor: el operador null tiene qué encontrar
        row[f] = genScalar(coll, f, type, rng, i);
      }
      coll.rows.set(row.id, row);
    }
    coll.nextId = n + 1;
    delete coll._created;
  }
  refresh(db);
}

// ── Valores heredados (5.7), generalizados desde la referencia ────────────────
function targetOf(db, coll, r, link) {
  const d = coll.relations[r];
  if (!d || !isObject(link) || d.missing) return null;
  const to = Array.isArray(d.to) ? (d.to.includes(link.type) ? link.type : null) : d.to;
  const target = to && db[to];
  return target ? [target, target.rows.get(link.id)] : null;
}
function source(db, coll, row, f, seen = new Set()) {
  const rule = coll.inherit[f];
  if (row[rule.own] != null) return { value: row[rule.own], href: `${coll.path}/${row.id}` };
  for (const r of rule.from) {
    const found = targetOf(db, coll, r, row[r]);
    if (!found) continue;
    const [to, target] = found;
    if (!target || seen.has(target)) continue;
    seen.add(target);
    return to.inherit[f] ? source(db, to, target, f, seen) : { value: target[f], href: `${to.path}/${target.id}` };
  }
  return { value: rule.default ? coll.defaults[f] : undefined };
}
function refresh(db) {
  for (const coll of Object.values(db)) {
    const inherits = Object.keys(coll.inherit).length > 0;
    for (const row of coll.rows.values()) {
      const why = {};
      if (inherits) {
        for (const f of [...Object.values(coll.inherit).map((i) => i.own), ...Object.keys(coll.relations).filter((r) => !coll.relations[r].many)]) row[f] ??= null;
        for (const f of Object.keys(coll.inherit)) {
          const s = source(db, coll, row, f);
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
function compare(type, a, b) {
  if (type === 'decimal') return cmpDecimal(String(a), String(b));
  if (type === 'integer' || type === 'number') return a - b;
  if (type === 'boolean') return Number(a) - Number(b);
  if (type === 'datetime') { const [x, xn] = instant(a), [y, yn] = instant(b); return x - y || xn - yn; }
  if (type === 'duration') return seconds(a) - seconds(b);
  return cmpText(String(a), String(b));
}

// ── El servidor ───────────────────────────────────────────────────────────────
class Problem extends Error {
  constructor(status, code, detail, extra = {}, headers = {}) { super(text(detail, 'en')); Object.assign(this, { status, code, detail, extra, headers }); }
}
const TITLES = {
  400: t('Bad request', 'Petición incorrecta'), 404: t('Not found', 'No encontrado'), 405: t('Method not allowed', 'Método no permitido'),
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
// 7.3: grupos de caché (RFC 9875) como lista de cadenas de Structured Fields; la colección, primero.
const groups = (paths) => [...new Set(paths)].slice(0, 32).map((g) => `"${g.replace(/[\\"]/g, '\\$&')}"`).join(', ');

export function createMock(model, options = {}) {
  const { db, served, profiles, has } = model;
  const seed = options.seed ?? 1;
  const link = profiles.map((p) => `<${SPEC}${p}>; rel="profile"`).join(', ');
  const cursorKey = createHash('sha256').update(`restep-mock cursor ${seed}`).digest();
  const sign = (s) => createHmac('sha256', cursorKey).update(s).digest('base64url').slice(0, 22);
  const idempotency = new Map();
  const byPath = new Map(Object.values(db).map((c) => [c.path, c]));
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
      type: `${SPEC}errors#${p.code}`, title: text(TITLES[p.status] ?? 'Error', lang), status: p.status,
      code: p.code, detail: text(p.detail, lang), ...extra,
    }, { 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...p.headers }, req.method === 'HEAD');
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
      if (!Object.hasOwn(coll.filter, field)) throw unsupported(key, t(`${field} cannot be filtered. Filterable: ${Object.keys(coll.filter).join(', ') || 'none'}.`, `${field} no se puede filtrar. Se puede por: ${Object.keys(coll.filter).join(', ') || 'ninguno'}.`));
      if (!coll.filter[field].ops.includes(op)) throw unsupported(key, t(`${field} supports: ${coll.filter[field].ops.join(', ')}.`, `${field} admite: ${coll.filter[field].ops.join(', ')}.`));
      if (seen.has(`${field}[${op}]`)) throw bad(key, SAME_FILTER);
      seen.add(`${field}[${op}]`);
      const type = typeOf(coll, field);
      const get = (r) => at(coll, r, field);
      if (op === 'null') {
        if (value !== 'true' && value !== 'false') throw bad(key, t('Use true or false.', 'Usa true o false.'));
        items = items.filter((r) => (get(r) == null) === (value === 'true'));
      } else if (op === 'in') {
        const values = value.split(',');
        if (values.some((v) => v === '')) throw bad(key, t('in needs a non-empty, comma-separated list.', 'in necesita una lista no vacía, separada por comas.'));
        const parsed = values.map((v) => parseValue(type, v, key));
        const ty = Array.isArray(type) ? 'enum' : type;
        items = items.filter((r) => get(r) != null && parsed.some((v) => compare(ty, get(r), v) === 0));
      } else {
        const v = parseValue(type, value, key), ty = Array.isArray(type) ? 'enum' : type;
        items = items.filter((r) => get(r) != null && OPS[op](compare(ty, get(r), v)));
      }
    }
    return items;
  }
  function parseSort(coll, params) {
    if (params.getAll('sort').length > 1) throw once('sort');
    const sort = (params.get('sort') ?? 'id').split(',');
    for (const s of sort) {
      const f = s.replace(/^-/, '');
      if (!f) throw bad('sort', t('Empty sort key.', 'Clave de orden vacía.'));
      if (!coll.sort.includes(f)) throw unsupported('sort', t(`${f} is not sortable. Sortable: ${coll.sort.join(', ')}.`, `${f} no se puede ordenar. Se puede por: ${coll.sort.join(', ')}.`));
    }
    return sort;
  }
  // include (8): rutas de relaciones expandibles, hasta include_depth.
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
        const full = expand(found[0], found[1], sub);
        return isObject(link) && link.type ? { ...full, type: link.type } : full;
      };
      if (Array.isArray(row[r])) out[r] = row[r].map(one);
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
      const one = (o) => (isObject(o) ? { ...pick(o, sub), ...(o.type && { type: o.type }) } : o);
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
        const d = compare(Array.isArray(ty) ? 'enum' : ty, x, y) * (s.startsWith('-') ? -1 : 1);
        if (d) return d;
      }
      return 0;
    });
    if (params.getAll('limit').length > 1) throw once('limit');
    const limit = params.has('limit') ? Number(params.get('limit')) : Math.min(20, coll.max_limit);
    if (!/^\d+$/.test(params.get('limit') ?? '1') || !Number.isInteger(limit) || limit < 1 || limit > coll.max_limit)
      throw bad('limit', t(`Between 1 and ${coll.max_limit}.`, `Entre 1 y ${coll.max_limit}.`));
    const print = queryPrint(path, params);
    const offset = readCursor(params, print);
    const count = params.get('count');
    if (count !== null && count !== 'true' && count !== 'false') throw bad('count', t('Use true or false.', 'Usa true o false.'));
    if (count === 'true' && !coll.count) throw unsupported('count');
    const include = has('relations') ? parseInclude(coll, params) : [];
    const fields = parseFields(params, coll, include);
    const page = items.slice(offset, offset + limit);
    let next = null;
    if (offset + limit < items.length) {
      const q = new URLSearchParams(params);
      q.set('cursor', makeCursor(offset + limit, print));
      next = `${path}?${q}`;
    }
    // Recuento «estimated»: se redondea a la decena, como haría un servidor que estima.
    const total = coll.count === 'estimated' ? Math.round(items.length / 10) * 10 : items.length;
    return {
      items: page.map((r) => pick(expand(coll, r, include), fields)), next,
      ...(count === 'true' && { total }),
      ...(count === 'true' && coll.count === 'estimated' && { total_estimated: true }),
    };
  }

  // ── Escrituras ──
  async function readJson(req, types) {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!types.includes(type))
      throw new Problem(415, 'unsupported_media_type', t(`Send ${types.join(' or ')}.`, `Envía ${types.join(' o ')}.`), {},
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
      try { now = current ? current[f] : source(db, coll, { ...body, id: '' }, f).value; } catch { now = undefined; }
      if (!same(body[f], now)) errors.push({ pointer: ptr(f), code: 'read_only', detail: t(`${f} is the effective value; write ${rule.own}.`, `${f} es el valor efectivo; escribe en ${rule.own}.`) });
      delete body[f];
    }
    return errors;
  }
  function relationErrors(coll, body, id) {
    const errors = [];
    for (const [r, d] of Object.entries(coll.relations)) {
      if (!(r in body) || body[r] === null) continue;
      const multi = Array.isArray(d.to);
      const one = (v, where) => {
        if (!isObject(v) || typeof v.id !== 'string' || (multi && typeof v.type !== 'string')) {
          errors.push({ pointer: where, code: 'type', detail: t(`${r} must be an object with an id${multi ? ' and a type' : ''}.`, `${r} tiene que ser un objeto con un id${multi ? ' y un type' : ''}.`) });
          return v;
        }
        const clean = multi ? { id: v.id, type: v.type } : { id: v.id };
        const found = targetOf(db, coll, r, clean);
        if (!found || !found[1]) errors.push({ pointer: where, code: 'unknown', detail: t(`There is no ${multi ? v.type : d.to} ${v.id}.`, `No hay ningún ${multi ? v.type : d.to} ${v.id}.`) });
        else if (found[0] === coll && id !== undefined) {
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
  function unlink(coll, id) {
    for (const other of Object.values(db)) {
      for (const [r, d] of Object.entries(other.relations)) {
        if (![].concat(d.to).includes(coll.name)) continue;
        const hit = (o) => isObject(o) && o.id === id && (!Array.isArray(d.to) || o.type === coll.name);
        for (const [k, row] of other.rows) {
          if (Array.isArray(row[r]) && row[r].some(hit)) other.rows.set(k, { ...row, [r]: row[r].filter((o) => !hit(o)) });
          else if (hit(row[r])) other.rows.set(k, { ...row, [r]: null });
        }
      }
    }
  }
  function idempotencyScope(req, path) {
    if (!has('writes')) return null; // 7.1: un servidor solo core no conoce la cabecera
    const raw = req.headers['idempotency-key'];
    if (raw === undefined) return null;
    const m = raw.trim().match(/^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/);
    if (!m) throw new Problem(400, 'bad_request', t('Idempotency-Key must be a quoted string, such as "8e03978e-40d5".', 'Idempotency-Key tiene que ser una cadena entre comillas, como "8e03978e-40d5".'));
    return `${hash(req.headers.authorization ?? 'anonymous')} ${req.method} ${path} ${m[1]}`;
  }

  // ── Encaminamiento ──
  const ONLY_READ = t('Only GET and HEAD.', 'Solo GET y HEAD.');
  const missing = (url) => new Problem(404, 'not_found', t(`${url.pathname} does not exist.`, `${url.pathname} no existe.`));
  const discoveryTag = etag(served);
  async function handle(req, res) {
    refresh(db);
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
      if (!read) throw new Problem(405, 'method_not_allowed', ONLY_READ, {}, { Allow: 'GET, HEAD' });
      for (const key of new Set(params.keys())) if (isReserved(reservedName(key))) throw unsupported(key);
      const headers = { ETag: discoveryTag, 'Cache-Control': 'public, max-age=300' };
      if (weakMatch(req.headers['if-none-match'], discoveryTag)) return send(res, 304, undefined, headers);
      return send(res, 200, served, headers, method === 'HEAD');
    }
    // La colección más larga cuyo path es prefijo de la ruta.
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let coll = byPath.get(path), id;
    if (!coll) {
      const cut = path.lastIndexOf('/');
      coll = byPath.get(path.slice(0, cut));
      id = coll ? decodeURIComponent(path.slice(cut + 1)) : undefined;
    }
    if (!coll || (id !== undefined && (id === '' || id.includes(':')))) throw missing(url);
    if (id !== undefined && !coll.rows.has(id)) throw missing(url);

    const methods = [...(id === undefined ? coll.methods : coll.item_methods), 'HEAD'];
    if (!methods.includes(method))
      throw new Problem(405, 'method_not_allowed', t(`Supports ${methods.join(', ')}.`, `Admite ${methods.join(', ')}.`), {}, { Allow: methods.join(', ') });

    const queryParams = has('query') ? (id === undefined ? ['filter', 'sort', 'fields', 'count', 'limit', 'cursor'] : ['fields']) : (id === undefined ? ['cursor'] : []);
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
      let data;
      if (id === undefined) data = list(coll, params, coll.path);
      else {
        const row = coll.rows.get(id);
        const include = has('relations') ? parseInclude(coll, params) : [];
        const fields = has('query') ? parseFields(params, coll, include) : null;
        data = fields || include.length ? { ...pick(expand(coll, row, include), fields), _etag: etag(row) } : row;
      }
      const tag = etag(data);
      const members = id === undefined ? data.items.map((r) => location(r)) : [location(data)];
      const headers = { ETag: tag, 'Cache-Control': 'no-cache', 'Cache-Groups': groups(id === undefined ? [coll.path, ...members] : members) };
      const itemTag = id === undefined ? tag : etag(coll.rows.get(id));
      if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], itemTag))
        throw new Problem(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
      if (weakMatch(req.headers['if-none-match'], tag)) return send(res, 304, undefined, headers);
      return send(res, 200, data, headers, method === 'HEAD');
    }

    if (id === undefined) { // POST
      const scope = idempotencyScope(req, url.pathname);
      const [body, sent] = await readJson(req, ['application/json']);
      const print = scope && hash(canonical(sent));
      const saved = scope && idempotency.get(scope);
      const live = saved && saved.expires > Date.now() ? saved : null;
      if (live && live.print === print) return send(res, ...live.response.slice(0, 2), { ...live.response[2], 'Idempotent-Replayed': 'true' });
      const collTag = etag(list(coll, new URLSearchParams(), url.pathname));
      if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], collTag))
        throw new Problem(412, 'precondition_failed', t('If-Match does not match the current collection.', 'If-Match no coincide con la colección actual.'));
      if (weakMatch(req.headers['if-none-match'], collTag))
        throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current collection.', 'If-None-Match coincide con la colección actual.'));
      if (live) throw new Problem(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
      if ('id' in body) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('The server assigns id.', 'El servidor asigna el id.') }]);
      validate(coll, body, undefined, [...languageErrors(coll, body), ...relationErrors(coll, body), ...inheritErrors(coll, body)]);
      while (coll.rows.has(String(coll.nextId))) coll.nextId++;
      const row = withMaps(coll, { ...body, id: String(coll.nextId++) });
      coll.rows.set(row.id, row);
      refresh(db);
      const stored = coll.rows.get(row.id);
      const response = [201, prefer ? undefined : structuredClone(stored), { Location: location(stored), ETag: etag(stored),
        'Cache-Group-Invalidation': groups([coll.path, location(stored)]), ...applied }];
      if (scope) idempotency.set(scope, { print, response, expires: Date.now() + TTL });
      return send(res, ...response);
    }

    const [patch] = method === 'PATCH' ? await readJson(req, ['application/merge-patch+json', 'application/json']) : [null];
    const current = coll.rows.get(id);
    if (!current) throw missing(url);
    if (req.headers['if-match'] !== undefined && !strongMatch(req.headers['if-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
    if (weakMatch(req.headers['if-none-match'], etag(current)))
      throw new Problem(412, 'precondition_failed', t('If-None-Match matches the current item.', 'If-None-Match coincide con el ítem actual.'));
    const invalidation = { 'Cache-Group-Invalidation': groups([coll.path, `${coll.path}/${id}`]) };
    if (method === 'DELETE') { unlink(coll, id); coll.rows.delete(id); return send(res, 204, undefined, invalidation); }
    if ('id' in patch && patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.', 'id no puede cambiar.') }]);
    const unknown = Object.keys(patch).filter((f) => !f.startsWith('_') && !Object.hasOwn(coll.types, f));
    if (unknown.length) throw invalid(unknown.map((f) => ({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) })));
    const errors = languageErrors(coll, patch, current);
    errors.push(...relationErrors(coll, patch, id), ...inheritErrors(coll, patch, current));
    // 5.1: una relación se sustituye entera, no se fusiona.
    const relValues = Object.fromEntries(Object.keys(coll.relations).filter((r) => patch[r] != null).map((r) => [r, patch[r]]));
    const row = withMaps(coll, { ...mergePatch(current, patch), ...relValues, id });
    validate(coll, row, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'), errors);
    coll.rows.set(id, row);
    refresh(db);
    const stored = coll.rows.get(id);
    return send(res, prefer ? 204 : 200, prefer ? undefined : stored, { ETag: etag(stored), ...invalidation, ...applied });
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
export const dumpData = (model) => Object.fromEntries(Object.entries(model.db).map(([n, c]) => [n, [...c.rows.values()]]));

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
    const sizes = Object.values(model.db).map((c) => `${c.name} (${c.rows.size})`).join(', ');
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
