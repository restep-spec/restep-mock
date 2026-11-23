// Pruebas de restep-mock. Desde projects/restep:  node tools/restep-mock/test.mjs
// La prueba clave: el descubrimiento del servidor de referencia, servido por el mock, pasa restep-check
// con --writes sin ningún fallo. Usa solo los puertos 8830-8839.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, 'restep-mock.mjs');
const REF = join(here, 'vendor/restep-server.mjs');
const CHECKER = join(here, 'vendor/restep-check.mjs');
const AGENDA = join(here, 'test/agenda.json');
const LIBRARY = join(here, 'test/biblioteca.json');
const tmp = mkdtempSync(join(tmpdir(), 'restep-mock-'));
const children = [];
let failed = 0, passed = 0;

function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FALLA ${name}${detail ? `\n        ${detail}` : ''}`); }
}
async function waitFor(url, child, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${url} no arranca: ${child.stderrText().trim()}`);
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error(`${url} no arranca`);
}
async function start(args, port, env = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  children.push(child);
  child.stderrText = () => err;
  await waitFor(`http://localhost:${port}/`, child);
  return child;
}
const stop = (child) => (child.exitCode !== null || child.signalCode !== null ? null : new Promise((r) => { child.on('exit', r); child.kill(); }));
const mock = (source, port, ...extra) => start([MOCK, source, '--port', String(port), ...extra], port);
function check(root) {
  const r = spawnSync(process.execPath, [CHECKER, root, '--writes'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const summary = r.stdout.trim().split('\n').at(-1);
  const fails = r.stdout.split('\n').filter((l) => /^\s+FAIL /.test(l));
  return { code: r.status, summary, fails, out: r.stdout };
}
const get = async (url, init) => { const res = await fetch(url, init); const body = await res.text(); return { res, body, json: body ? JSON.parse(body) : undefined }; };

try {
  console.log('Servidor de referencia → descubrimiento → mock → restep-check');
  await start([REF], 8830, { PORT: '8830' });
  const discovery = await (await fetch('http://localhost:8830/')).json();
  const file = join(tmp, 'discovery.json');
  writeFileSync(file, JSON.stringify(discovery, null, 2));
  await mock(file, 8831);
  const ref = check('http://localhost:8831/');
  console.log(`  restep-check contra el mock de la referencia: ${ref.summary}`);
  ok(ref.code === 0 && /^0 failed/.test(ref.summary), 'restep-check --writes pasa sin fallos', ref.fails.join('\n        '));
  const served = await (await fetch('http://localhost:8831/')).json();
  ok(JSON.stringify(served) === JSON.stringify(discovery), 'sirve el mismo descubrimiento que la referencia (singletons, inherit, collations, id_from y deprecations incluidos)');
  const page = await get('http://localhost:8831/books?limit=50&count=true');
  ok(page.json.items.length === 50 && page.json.total === 50, 'genera 50 elementos por colección por defecto');
  // Borrador 6, contra el mock de la referencia.
  const R = 'http://localhost:8831';
  const shop = await get(`${R}/shop`);
  ok(shop.res.status === 200 && typeof shop.json.name === 'string' && shop.json._etag === shop.res.headers.get('etag'), 'el singleton /shop responde con un objeto y su _etag (5.9)', shop.body);
  const shopPost = await get(`${R}/shop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(shopPost.res.status === 405 && /PATCH/.test(shopPost.res.headers.get('allow')), 'POST al singleton da 405 con Allow', shopPost.res.headers.get('allow'));
  const shopInclude = await get(`${R}/shop?include=x`);
  ok(shopInclude.json?.code === 'unsupported_parameter', 'include en el singleton da unsupported_parameter');
  const shopPatch = await get(`${R}/shop`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ max_reservations: 5 }) });
  ok(shopPatch.res.status === 200 && shopPatch.json.max_reservations === 5 && shopPatch.json._etag, 'PATCH al singleton', shopPatch.body);
  const year = await get(`${R}/books?sort=year`);
  ok(year.res.headers.get('deprecation')?.startsWith('@') && /rel="deprecation"/.test(year.res.headers.get('link')), 'ordenar por year, avisado en deprecations, lleva Deprecation y Link rel="deprecation" (5.5)');
  const latin = await get(`${R}/books`, { method: 'POST', headers: { 'content-type': 'application/json; charset=latin1' }, body: JSON.stringify({ title: 'x', price: '1.00' }) });
  ok(latin.res.status === 415, 'un POST con charset=latin1 da 415 (3)');
  const empty = await get(`${R}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' });
  ok(empty.res.status === 400 && empty.json.code === 'bad_request', 'un cuerpo vacío con application/json da 400 (3)');
  const plainPatch = await get(`${R}/books/7`, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body: '{}' });
  ok(plainPatch.res.status === 415 && plainPatch.res.headers.get('accept-patch') === 'application/merge-patch+json', 'un PATCH como text/plain da 415 con Accept-Patch (5.1)');
  const mine = await get(`${R}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mi-categoria', name: 'Mía' }) });
  ok(mine.res.status === 201 && mine.res.headers.get('location') === '/categories/mi-categoria', 'id_from "either": el cliente elige el id (5.1)', mine.body);
  const folded = await get(`${R}/categories?filter%5Bname%5D=MIA&limit=50`);
  ok(folded.res.status === 200 && folded.json.items.some((c) => c.id === 'mi-categoria'), 'collations "server": name=MIA encuentra «Mía», sin mayúsculas ni acentos (6.1)', folded.body.slice(0, 200));
  await fetch(`${R}/categories/mi-categoria`, { method: 'DELETE' });
  const again = await get(`${R}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mi-categoria', name: 'Otra' }) });
  ok(again.res.status === 409 && again.json.errors?.[0]?.code === 'taken', 'el id de un elemento borrado da 409 taken', again.body);
  const bookId = await get(`${R}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x', title: 'x', price: '1.00' }) });
  ok(bookId.res.status === 422 && bookId.json.errors?.some((e) => e.pointer === '/id' && e.code === 'read_only'), 'sin id_from, un POST con id da 422 read_only en /id');
  const key = (k) => ({ 'content-type': 'application/json', 'idempotency-key': `"${k}"` });
  await get(`${R}/books?origen=a`, { method: 'POST', headers: key('q-1'), body: JSON.stringify({ title: 'Q', price: '1.00' }) });
  const otherQuery = await get(`${R}/books?origen=b`, { method: 'POST', headers: key('q-1'), body: JSON.stringify({ title: 'Q', price: '1.00' }) });
  ok(otherQuery.res.status === 422 && otherQuery.json.code === 'idempotency_mismatch', 'la misma clave con otra query da 422 idempotency_mismatch (7.1)');
  const pct = await get(`${R}/books/%37`);
  ok(pct.res.status === 200 && pct.json.id === '7', '/books/%37 es /books/7 (3)');

  console.log('Descubrimiento por URL');
  await mock('http://localhost:8830/', 8832, '--count', 'books=7');
  const byUrl = await get('http://localhost:8832/books?count=true');
  ok(byUrl.json.total === 7, '--count books=7 se aplica a esa colección', byUrl.body);
  const products = await get('http://localhost:8832/products?count=true');
  ok(products.json.total === 50, 'y las demás siguen con el valor por defecto');

  console.log('Descubrimiento propio: fechas, duraciones, booleanos, relations, esquema enlazado');
  const agenda = await mock(AGENDA, 8833);
  const ag = check('http://localhost:8833/');
  console.log(`  restep-check contra el mock de la agenda: ${ag.summary}`);
  ok(ag.code === 0 && /^0 failed/.test(ag.summary), 'restep-check --writes pasa sin fallos', ag.fails.join('\n        '));
  const doc = (await get('http://localhost:8833/')).json;
  // Desde 0.3.0 el mock simula actions: se sirven; sync sigue sin simularse y se quita.
  ok(!doc.profiles.includes('sync') && JSON.stringify(doc.extensions) === '["actions"]' && doc.collections.talks.actions?.cancel && !doc.collections.speakers.sync,
    'quita del descubrimiento lo que no implementa (sync) y sirve lo que sí (actions)', JSON.stringify(doc.extensions));
  ok(/No se implementa sync/.test(agenda.stderrText()), 'y lo avisa por la salida de errores');
  const schema = await get('http://localhost:8833/schemas/venue.json');
  ok(schema.res.status === 200 && schema.json.properties.capacity.minimum === 20, 'sirve el esquema enlazado en su ruta');
  const venues = (await get('http://localhost:8833/venues?limit=50')).json.items;
  ok(venues.every((v) => v.capacity >= 20 && v.capacity <= 1200), 'respeta minimum y maximum del esquema al generar');
  const bigVenue = await get('http://localhost:8833/venues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sala grande', capacity: 5000 }) });
  ok(bigVenue.res.status === 422 && bigVenue.json.errors.some((e) => e.pointer === '/capacity' && e.code === 'range'), 'y los valida al escribir (422 range)');
  const speakers = (await get('http://localhost:8833/speakers?limit=25')).json.items;
  ok(speakers.every((s) => /^[a-z]+\.[a-z]+\d+@example\.com$/.test(s.email)), 'los email parecen email', speakers[0].email);
  ok(speakers.every((s) => s.birth_date == null || /^\d{4}-\d{2}-\d{2}$/.test(s.birth_date)), 'birth_date es una fecha');
  ok(speakers.every((s) => typeof s.active === 'boolean' || s.active === null), 'active es booleano');
  const talk = await get('http://localhost:8833/talks/2?include=venue,speakers&fields=title,venue.name,speakers.email');
  ok(talk.res.status === 200 && typeof talk.json.venue?.name === 'string' && talk.json._etag && Object.keys(talk.json.venue).sort().join() === 'id,name',
    'include y fields con punto devuelven solo lo pedido del elemento incluido', talk.body);
  const cg = await get('http://localhost:8833/venues?limit=2');
  ok(cg.res.headers.get('cache-groups') === '"/venues", "/venues/1", "/venues/10"', 'Cache-Groups con la colección primero y sus elementos', cg.res.headers.get('cache-groups'));
  const noInclude = await get('http://localhost:8833/talks?fields=venue.name');
  ok(noInclude.json?.code === 'invalid_parameter' && noInclude.json.parameter === 'fields', 'fields con punto sin include da invalid_parameter');
  const deep = await get('http://localhost:8833/talks?include=venue.city');
  ok(deep.json?.code === 'unsupported_parameter', 'include más hondo que include_depth da unsupported_parameter');
  const years = await get('http://localhost:8833/talks?filter%5Bduration%5D%5Ble%5D=P1Y');
  ok(years.json?.code === 'invalid_parameter', 'una duración con años en un filtro da invalid_parameter');
  const late = await get('http://localhost:8833/talks?filter%5Bstarts_at%5D%5Bge%5D=2026-01-01T00:00:00%2B01:00&limit=30');
  ok(late.res.status === 200 && late.json.items.every((x) => Date.parse(x.starts_at) >= Date.parse('2025-12-31T23:00:00Z')), 'los datetime se comparan como instantes, con desfase');

  console.log('Semilla');
  const dump = (...a) => spawnSync(process.execPath, [MOCK, AGENDA, '--dump', '--quiet', ...a], { encoding: 'utf8' }).stdout;
  ok(dump('--seed', '7') === dump('--seed', '7'), 'misma semilla, mismos datos');
  ok(dump('--seed', '7') !== dump('--seed', '8'), 'otra semilla, otros datos');

  console.log('Fallos y latencia simulados');
  const failing = await mock(AGENDA, 8834, '--fail-rate', '1', '--retry-after', '3', '--quiet');
  const down = await get('http://localhost:8834/talks');
  ok(down.res.status === 503 && down.res.headers.get('content-type') === 'application/problem+json' && down.json.code === 'unavailable'
    && down.res.headers.get('retry-after') === '3', '--fail-rate 1 da 503 unavailable en problem+json con Retry-After');
  const health = await get('http://localhost:8834/status');
  ok(health.res.status === 200, 'el estado del servicio no se cae con la API');
  await stop(failing); // su puerto se reutiliza abajo
  await mock(AGENDA, 8835, '--fail-rate', '0.5', '--seed', '3', '--quiet');
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await fetch('http://localhost:8835/venues')).status);
  const fails = codes.filter((c) => c === 503).length;
  ok(fails > 5 && fails < 35 && codes.every((c) => c === 200 || c === 503), `--fail-rate 0.5 falla una parte (${fails} de 40)`);
  await mock(AGENDA, 8836, '--latency', '150-200', '--quiet');
  const t0 = Date.now();
  await fetch('http://localhost:8836/venues');
  ok(Date.now() - t0 >= 150, `--latency 150-200 retrasa la respuesta (${Date.now() - t0} ms)`);

  console.log('default de create (4.3)');
  const withDefaults = join(tmp, 'defaults.json');
  writeFileSync(withDefaults, JSON.stringify({ restep: '1.0', profiles: ['core'], collections: { books: { path: '/books',
    schemas: { create: { type: 'object', required: ['title'], properties: {
      title: { type: 'string' }, status: { type: 'string', enum: ['draft', 'published'], default: 'draft' },
      signed: { default: false, anyOf: [{ type: 'boolean' }, { type: 'null' }] } } } } } } }));
  await mock(withDefaults, 8837, '--quiet', '--count', '0');
  const post = (body) => get('http://localhost:8837/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const made = await post({ title: 'Sin estado' });
  ok(made.res.status === 201 && made.json.status === 'draft' && made.json.signed === false, 'un POST sin el campo lo guarda con su default', made.body);
  const kept = await post({ title: 'Con estado', status: 'published', signed: null });
  ok(kept.res.status === 201 && kept.json.status === 'published' && (kept.json.signed ?? null) === null, 'lo enviado, null incluido, no toma el default', kept.body);
  const listed = await get('http://localhost:8837/books');
  ok(!made.res.headers.has('cache-group-invalidation') && !listed.res.headers.has('cache-groups'),
    'sin el perfil cache no envía Cache-Groups ni Cache-Group-Invalidation (8)', [...made.res.headers.keys()].join(', '));

  console.log('Borrador 6: versión, extensiones, singletons, retiradas vencidas, límites');
  const d6 = join(tmp, 'borrador6.json');
  writeFileSync(d6, JSON.stringify({ restep: '1.0-draft.5', profiles: ['core', 'query', 'writes'], extensions: ['batch'],
    idempotency: { anonymous: false },
    deprecations: [{ kind: 'collection', name: 'old', announced: '2025-01-01T00:00:00Z', sunset: '2025-07-01T00:00:00Z' },
      { kind: 'reason', name: 'gone', announced: '2025-01-01T00:00:00Z', sunset: '2025-07-01T00:00:00Z' }],
    collections: {
      items: { path: '/items', filter: { id: { type: 'string', ops: ['eq', 'in'] }, price: { type: 'decimal', ops: ['eq', 'lt'] } },
        sort: ['id', 'price', 'title'],
        deprecations: [{ kind: 'sort', name: 'title', announced: '2025-01-01T00:00:00Z', sunset: '2025-07-01T00:00:00Z' },
          { kind: 'operator', name: 'price', op: 'lt', announced: '2025-01-01T00:00:00Z', sunset: '2025-07-01T00:00:00Z' },
          { kind: 'field', name: 'title', announced: '2025-01-01T00:00:00Z', sunset: '2025-07-01T00:00:00Z' }],
        inherit: { tax: { own: 'tax_own', from: [] } } },
      old: { path: '/old' },
      notes: { path: '/items/{item_id}/notes', parent: 'items' } },
    singletons: { me: { path: '/me', methods: ['GET'] }, bad: { path: '/users/{id}' } } }));
  const m6 = await mock(d6, 8838, '--count', '5');
  const doc6 = (await get('http://localhost:8838/')).json;
  ok(doc6.restep === '1.0-draft.6' && /borrador 6/.test(m6.stderrText()), 'sirve "restep": "1.0-draft.6" y avisa si el documento decía otra versión (1.1)', doc6.restep);
  ok(JSON.stringify(doc6.extensions) === '["inherit"]', 'anuncia inherit si alguna colección lo declara, y quita batch (11.6)', JSON.stringify(doc6.extensions));
  ok(doc6.collections.notes?.parent === 'items' && !doc6.singletons.bad && doc6.singletons.me, 'sirve la subcolección y omite el singleton con plantilla');
  ok(!doc6.collections.items.sort.includes('title') && JSON.stringify(doc6.collections.items.filter.price.ops) === '["eq"]',
    'una retirada vencida de sort u operator se aplica: deja de declararse (5.5)', JSON.stringify(doc6.collections.items));
  ok(!(doc6.deprecations ?? []).some((d) => d.kind === 'reason') && !(doc6.collections.items.deprecations ?? []).some((d) => d.kind === 'field'),
    'y no sirve los avisos vencidos que no sabe simular (field, reason)');
  const sorted = await get('http://localhost:8838/items?sort=title');
  ok(sorted.json?.code === 'unsupported_parameter', 'ordenar por lo retirado da unsupported_parameter');
  const gone = await get('http://localhost:8838/old');
  ok(gone.res.status === 410 && gone.json.code === 'retired', 'una colección retirada da 410 retired');
  const me = await get('http://localhost:8838/me');
  ok(me.res.status === 200 && me.res.headers.get('content-type') === 'application/json', 'un singleton sin esquema responde con un objeto');
  const noMax = await get('http://localhost:8838/items?limit=2');
  ok(noMax.json?.code === 'unsupported_parameter' && noMax.json.parameter === 'limit', 'limit sin max_limit declarado da unsupported_parameter (6.4)');
  const noCount = await get('http://localhost:8838/items?count=false');
  ok(noCount.json?.code === 'unsupported_parameter', 'count=false sin count declarado da unsupported_parameter (6.5)');
  const anon = await get('http://localhost:8838/items', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"a-1"' }, body: '{}' });
  ok(anon.res.status === 400 && anon.json.errors?.[0]?.header === 'Idempotency-Key', '"anonymous": false: una clave sin credenciales da 400 con una entrada para la cabecera (7.1)', anon.body);
  const malformed = await get('http://localhost:8838/items', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"a"; p=1', authorization: 'Bearer x' }, body: '{}' });
  ok(malformed.res.status === 400 && malformed.json.errors?.[0]?.header === 'Idempotency-Key', 'una clave con parámetros da 400 con una entrada para la cabecera');

  console.log('Subcolecciones, actions y relations (test/biblioteca.json)');
  const lib = await mock(LIBRARY, 8839, '--count', 'authors=6', '--count', 'shelves=6');
  const L = 'http://localhost:8839';
  const libCheck = check(`${L}/`);
  console.log(`  restep-check contra el mock de la biblioteca: ${libCheck.summary}`);
  ok(libCheck.code === 0 && /^0 failed/.test(libCheck.summary), 'restep-check --writes pasa sin fallos', libCheck.fails.join('\n        '));
  const libDoc = (await get(`${L}/`)).json;
  const err = lib.stderrText();
  ok(libDoc.collections.books?.parent === 'authors' && libDoc.collections.reviews?.parent === 'books' && !libDoc.collections.orphans,
    'sirve las subcolecciones (dos niveles) y omite la que cuelga de algo que no existe', Object.keys(libDoc.collections).join());
  ok(JSON.stringify(libDoc.extensions) === '["actions"]' && libDoc.collections.books.actions.reserve && !libDoc.collections.books.actions.changes
    && !libDoc.collections.shelves.actions.broken, 'sirve actions y quita las que el texto prohíbe (changes, GET no segura)');
  ok(!libDoc.collections.shelves.filter['books.id'] && libDoc.collections.shelves.filter['featured.id'] && /6\.1/.test(err),
    'quita del filtro la ruta que pasa por una relación a muchos (6.1), y lo avisa');
  const books1 = await get(`${L}/authors/1/books?limit=20`);
  ok(books1.res.status === 200 && books1.json.items.length === 3 && books1.json.items[0].id === '1', 'cada padre tiene sus elementos (3 por defecto), con id propios', books1.body.slice(0, 120));
  ok((await get(`${L}/authors/999/books`)).res.status === 404 && (await get(`${L}/authors/999/books/1`)).res.status === 404, '404 si el padre no existe');
  const rv = await get(`${L}/authors/2/books/1/reviews`);
  ok(rv.res.status === 200 && Array.isArray(rv.json.items), 'un segundo nivel: /authors/2/books/1/reviews');
  const book = await get(`${L}/authors/2/books/1`);
  const withReviews = await get(`${L}/authors/2/books/1?include=reviews`);
  ok(!('reviews' in book.json) && Array.isArray(withReviews.json.reviews) && withReviews.json.reviews.length === rv.json.items.length
    && withReviews.json.reviews.every((r) => r.href === `/authors/2/books/1/reviews/${r.id}` && typeof r.stars === 'number'),
    'la relación que lleva a la subcolección no se incrusta; con include trae sus elementos, con href (9)', JSON.stringify(withReviews.json.reviews));
  const withBest = (await get(`${L}/authors/2/books?limit=20`)).json.items.filter((b) => b.best_review);
  ok(withBest.length && withBest.every((b) => /^\/authors\/[^/]+\/books\/[^/]+\/reviews\/[^/]+$/.test(b.best_review.href)),
    'un enlace a una subcolección que cuelga de la propia colección también se genera, con href', JSON.stringify(withBest[0]?.best_review));
  const nb = await get(`${L}/authors/2/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Nuevo', year: 2020 }) });
  ok(nb.res.status === 201 && nb.res.headers.get('location') === '/authors/2/books/4', 'POST en una subcolección: Location con la ruta del padre', nb.res.headers.get('location'));
  const back = await get(`${L}/authors/2/books/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(book.json) });
  ok(back.res.status === 200 && back.json._etag === book.json._etag, 'devolver el elemento tal como se leyó no cambia nada (ni su ETag)');
  const forged = await get(`${L}/authors/2/books/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ reviews: [{ id: 'x', href: '/authors/2/books/1/reviews/x' }] }) });
  ok(forged.res.status === 422 && forged.json.errors[0].code === 'read_only', 'esa relación no se escribe: otro valor da read_only', forged.body);
  const sh = (await get(`${L}/shelves/1`)).json;
  ok((sh.books ?? []).every((b) => typeof b.href === 'string' && /^\/authors\/[^/]+\/books\/[^/]+$/.test(b.href)), 'un enlace a un elemento de subcolección lleva href (3)', JSON.stringify(sh.books));
  const patchShelf = (books) => get(`${L}/shelves/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ books }) });
  let r = await patchShelf([{ id: '1' }]);
  ok(r.res.status === 422 && r.json.errors[0].pointer === '/books/0/href', 'enlazar sin href da 422 en /books/0/href', r.body);
  r = await patchShelf([{ id: '2', href: '/authors/3/books/1' }]);
  ok(r.res.status === 422 && r.json.errors[0].pointer === '/books/0/href', 'un href cuyo último segmento no es el id da 422');
  r = await patchShelf([{ id: '9', href: '/authors/3/books/9' }]);
  ok(r.res.status === 422 && r.json.errors[0].pointer === '/books/0/id' && r.json.errors[0].code === 'unknown', 'un elemento que no existe da unknown en su id');
  r = await patchShelf([{ id: '1', href: '/authors/3/books/1', extra: 1 }]);
  ok(r.res.status === 200 && JSON.stringify(r.json.books) === '[{"id":"1","href":"/authors/3/books/1"}]', 'con su href se enlaza, y solo se guardan id y href', r.body);
  const inc = await get(`${L}/shelves/1?include=books&fields=label,books.title`);
  ok(inc.res.status === 200 && inc.json.books[0].title && inc.json.books[0].href === '/authors/3/books/1' && !('year' in inc.json.books[0]),
    'include de un elemento de subcolección lo rellena, conserva href, y fields con punto proyecta', inc.body);
  ok((await get(`${L}/shelves/1?include=books&fields=books.nope`)).json?.code === 'invalid_parameter', 'fields con un campo que el incluido no tiene da invalid_parameter');
  ok((await get(`${L}/shelves?include=featured.books`)).res.status === 400, 'include que sigue a través de una relación polimórfica da 400');
  const poly = (await get(`${L}/shelves?include=featured&limit=50`)).json.items.find((x) => x.featured);
  ok(poly && typeof poly.featured.type === 'string' && Object.keys(poly.featured).length > 2, 'include de una relación polimórfica rellena el elemento de su type', JSON.stringify(poly?.featured));
  await fetch(`${L}/authors/3`, { method: 'DELETE' });
  ok((await get(`${L}/authors/3/books`)).res.status === 404 && (await get(`${L}/shelves/1`)).json.books.length === 0,
    'borrar el padre borra su subcolección y los enlaces a sus elementos');

  console.log('Actions (11.1)');
  const act = (path, init = {}) => get(`${L}${path}`, { method: 'POST', ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  r = await act('/authors/1/books/1:reserve', { body: '{}' });
  ok(r.res.status === 422 && r.json.errors.some((e) => e.pointer === '/hours' && e.code === 'required'), 'valida el cuerpo frente a su input: 422 required', r.body);
  r = await act('/authors/1/books/1:reserve', { body: JSON.stringify({ hours: 99, extra: true }) });
  ok(r.res.status === 422 && r.json.errors.some((e) => e.code === 'range') && r.json.errors.some((e) => e.code === 'unknown'), 'range y unknown según el esquema');
  r = await act('/authors/1/books/1%3Areserve', { body: JSON.stringify({ hours: 3 }) });
  ok(r.res.status === 200 && r.json.id === '1' && r.json._etag === r.res.headers.get('etag'), 'responde el elemento afectado (200), también con %3A', r.body);
  ok((await act('/authors/1/books/999:reserve', { body: JSON.stringify({ hours: 3 }) })).res.status === 404, '404 si el elemento no existe');
  ok((await act('/authors/1/books:reserve', { body: '{}' })).res.status === 404, '404 si la acción es de elemento y se pide en la colección');
  ok((await act('/authors/1/books/1:nope', { body: '{}' })).res.status === 404, '404 si la acción no está declarada');
  r = await get(`${L}/authors/1/books/1:reserve`);
  ok(r.res.status === 405 && r.res.headers.get('allow') === 'POST', 'otro método da 405 con Allow');
  r = await act('/authors/1/books/1:reserve', { body: JSON.stringify({ hours: 3 }), headers: { 'content-type': 'text/plain' } });
  ok(r.res.status === 415, 'un cuerpo que no es application/json da 415');
  const k = { 'idempotency-key': '"accion-1"' };
  const first = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 4 }), headers: k });
  const again2 = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 4 }), headers: k });
  ok(first.res.status === 200 && again2.res.headers.get('idempotent-replayed') === 'true' && again2.body === first.body, 'no idempotente: la misma clave repite la respuesta guardada (7.1)');
  r = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 5 }), headers: k });
  ok(r.res.status === 422 && r.json.code === 'idempotency_mismatch', 'y con otro cuerpo da idempotency_mismatch');
  r = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 5 }), headers: { 'idempotency-key': 'sin-comillas' } });
  ok(r.res.status === 400 && r.json.errors?.[0]?.header === 'Idempotency-Key', 'una clave mal formada da 400');
  r = await get(`${L}/shelves:reorder`, { method: 'POST', headers: { 'content-type': 'text/plain', 'idempotency-key': '"x"' } });
  ok(r.res.status === 204, 'idempotente de colección: cuerpo vacío con cualquier tipo es {}, no rechaza la clave y responde 204');
  r = await get(`${L}/authors/1/books/1:preview`);
  ok(r.res.status === 200 && r.json.id === '1' && r.res.headers.get('cache-control'), 'una acción GET responde el elemento');
  r = await get(`${L}/shelves:summary`);
  ok(r.res.status === 200 && Array.isArray(r.json.items) && 'next' in r.json, 'una acción GET de colección responde su primera página');
  ok((await get(`${L}/shelves:summary?limit=2`)).json?.code === 'unsupported_parameter', 'un parámetro reservado en una acción da unsupported_parameter');
  const tag = (await get(`${L}/authors/1/books/1`)).res.headers.get('etag');
  r = await act('/authors/1/books/1:reserve', { body: JSON.stringify({ hours: 1 }), headers: { 'if-match': '"otra"' } });
  ok(r.res.status === 412 && tag, 'If-Match contra el elemento: 412 con otra ETag (7.2)');

  console.log('Enlaces a subcolecciones y colecciones sin GET (4.3, 9)');
  // Un libro destaca una de sus reseñas; una lista elige una reseña de cualquier libro; las sugerencias solo
  // admiten POST.
  const linked = join(tmp, 'enlaces.json');
  writeFileSync(linked, JSON.stringify({ restep: '1.0-draft.6', version: '1', profiles: ['core', 'query', 'relations'], collections: {
    books: { path: '/books', methods: ['GET'], item_methods: ['GET'], max_limit: 50,
      relations: { reviews: { to: 'reviews', many: true, path: '/books/{book_id}/reviews' }, highlight: { to: 'reviews', include: true } } },
    reviews: { path: '/books/{book_id}/reviews', parent: 'books', methods: ['GET'], item_methods: ['GET'], max_limit: 50,
      relations: { reply_to: { to: 'reviews', include: true } } },
    lists: { path: '/lists', methods: ['GET'], item_methods: ['GET'], max_limit: 50, relations: { pick: { to: 'reviews', include: true } } },
    suggestions: { path: '/suggestions', methods: ['POST'], item_methods: ['GET'] } } }));
  await mock(linked, 8834, '--count', '8', '--quiet');
  const E = 'http://localhost:8834';
  const shelf = (await get(`${E}/books?include=highlight&limit=50`)).json.items;
  const highlights = shelf.filter((b) => b.highlight);
  ok(highlights.length && highlights.every((b) => b.highlight.href === `/books/${b.id}/reviews/${b.highlight.id}`),
    'el destacado de un libro es una reseña de ese mismo libro, no de otro padre', JSON.stringify(highlights.map((b) => [b.id, b.highlight.href])));
  ok(highlights.every((b) => typeof b.highlight.reply_to !== 'undefined' && 'reply_to' in b.highlight), 'include de una relación a uno cuyo destino es una subcolección la rellena (9)', JSON.stringify(highlights[0]));
  const replies = (await Promise.all(shelf.map((b) => get(`${E}/books/${b.id}/reviews?limit=50`)))).flatMap((x, n) => x.json.items.map((r) => [shelf[n].id, r]));
  ok(replies.filter(([, r]) => r.reply_to).every(([b, r]) => r.reply_to.href.startsWith(`/books/${b}/reviews/`)), 'una reseña responde a otra del mismo libro');
  const picks = (await get(`${E}/lists?include=pick&limit=50`)).json.items.filter((l) => l.pick);
  ok(picks.length && picks.every((l) => typeof l.pick.reply_to !== 'undefined' && /^\/books\/[^/]+\/reviews\/[^/]+$/.test(l.pick.href)),
    'desde una colección de primer nivel, include también rellena el elemento de la subcolección', JSON.stringify(picks[0]));
  const head = await fetch(`${E}/suggestions`, { method: 'HEAD' });
  ok(head.status === 405 && head.headers.get('allow') === 'POST', 'sin GET declarado, HEAD da 405 y Allow lista solo los métodos declarados (4.3)', `${head.status} Allow: ${head.headers.get('allow')}`);
  const getNo = await get(`${E}/suggestions`);
  ok(getNo.res.status === 405 && getNo.res.headers.get('allow') === 'POST', 'y GET también da 405 con Allow: POST', getNo.res.headers.get('allow'));
  // 6.2 y 5.3: books no declara sort, así que sort=id no está implementado (aunque el orden por defecto sea por id).
  const noSort = await get(`${E}/books?sort=id`);
  ok(noSort.res.status === 400 && noSort.json?.code === 'unsupported_parameter' && noSort.json.parameter === 'sort',
    'sin sort declarado, sort=id da unsupported_parameter con parameter sort (6.2)', noSort.body);
  const plain = (await get(`${E}/books?limit=50`)).json.items.map((b) => b.id);
  ok(plain.length > 1 && plain.join() === [...plain].sort((a, b) => Number(a) - Number(b)).join(), 'y sin sort la colección sigue en su orden por defecto, por id', plain.join());
  const linkedCheck = check(E);
  ok(linkedCheck.code === 0 && /^0 failed/.test(linkedCheck.summary) && /core\.methods\.left-out/.test(spawnSync(process.execPath, [CHECKER, E, '--verbose'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).stdout),
    'restep-check --writes pasa sin fallos, con suggestions sin GET (core.methods.left-out)', linkedCheck.fails.join('\n        '));

  console.log('Errores de uso');
  const bad = (args, re, name) => {
    const r = spawnSync(process.execPath, [MOCK, ...args], { encoding: 'utf8' });
    ok(r.status === 2 && re.test(r.stderr), name, r.stderr.trim());
  };
  bad([], /falta el documento/, 'sin argumentos');
  bad([AGENDA, '--fail-rate', '2'], /entre 0 y 1/, '--fail-rate fuera de rango');
  bad([AGENDA, '--latency', '300-100'], /--latency/, '--latency al revés');
  bad([join(tmp, 'no-existe.json')], /No se puede leer/, 'archivo que no existe');
  const notDiscovery = join(tmp, 'otro.json');
  writeFileSync(notDiscovery, '{"openapi": "3.1.0"}');
  bad([notDiscovery], /no es un documento de descubrimiento/, 'un JSON que no es descubrimiento');
  for (const v of ['2.0', '1.01', '1.0-beta.1']) {
    const f = join(tmp, `v-${v}.json`);
    writeFileSync(f, JSON.stringify({ restep: v, collections: {} }));
    bad([f], /solo entiende Restep 1/, `"restep": "${v}" no es Restep 1 (1.1)`);
  }
} catch (e) {
  failed++;
  console.log(`  FALLA ${e.stack}`);
} finally {
  // Espera a que terminen, para que otra ejecución seguida encuentre los puertos libres.
  await Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => { c.on('exit', r); c.kill(); }))));
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${failed ? `${failed} fallos` : '0 fallos'} · ${passed} correctas`);
process.exit(failed ? 1 : 0);
