// Tests of restep-mock. From projects/restep:  node tools/restep-mock/test.mjs
// The key test: the reference server's discovery document, served by the mock, passes restep-check
// with --writes with no failure. It uses only ports 8828-8839.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, 'restep-mock.mjs');
// RESTEP_REF: another copy of the reference server (while public/ref is being edited, for instance).
const REF = process.env.RESTEP_REF ?? join(here, 'vendor/restep-server.mjs');
const CHECKER = join(here, 'vendor/restep-check.mjs');
const AGENDA = join(here, 'test/agenda.json');
const LIBRARY = join(here, 'test/biblioteca.json');
const tmp = mkdtempSync(join(tmpdir(), 'restep-mock-'));
const children = [];
let failed = 0, passed = 0;

function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n        ${detail}` : ''}`); }
}
async function waitFor(url, child, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${url} does not start: ${child.stderrText().trim()}`);
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error(`${url} does not start`);
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
  console.log('Reference server → discovery → mock → restep-check');
  await start([REF], 8830, { PORT: '8830' });
  const discovery = await (await fetch('http://localhost:8830/')).json();
  const file = join(tmp, 'discovery.json');
  writeFileSync(file, JSON.stringify(discovery, null, 2));
  await mock(file, 8831);
  const ref = check('http://localhost:8831/');
  console.log(`  restep-check against the reference mock:  ${ref.summary}`);
  ok(ref.code === 0 && /^0 failed/.test(ref.summary), 'restep-check --writes passes with no failures', ref.fails.join('\n        '));
  const served = await (await fetch('http://localhost:8831/')).json();
  // The one thing it leaves out: inherit_items (11.6), which it does not simulate.
  const { restep: servedVersion, ...servedRest } = served, { restep: refVersion, ...refRest } = structuredClone(discovery);
  for (const c of Object.values(refRest.collections)) delete c.inherit_items;
  ok(JSON.stringify(servedRest) === JSON.stringify(refRest) && servedVersion === '1.0-draft.7',
    'serves the same discovery as the reference, declaring draft 7, but for inherit_items (singletons, inherit, collations, id_from and deprecations included)', `${refVersion} → ${servedVersion}`);
  const page = await get('http://localhost:8831/books?limit=50&count=true');
  ok(page.json.items.length === 50 && page.json.total === 50, 'generates 50 items per collection by default');
  // Draft 6, against the reference mock.
  const R = 'http://localhost:8831';
  const shop = await get(`${R}/shop`);
  ok(shop.res.status === 200 && typeof shop.json.name === 'string' && shop.json._etag === shop.res.headers.get('etag'), 'the /shop singleton answers with an object and its _etag (5.9)', shop.body);
  if (discovery.singletons?.me?.actions?.verify_email) {
    const verify = await get(`${R}/me:verify_email`, { method: 'POST' });
    const verifyGet = await get(`${R}/me:verify_email`);
    const nope = await get(`${R}/me:nope`, { method: 'POST' });
    ok(verify.res.status === 200 && verify.json._etag && verifyGet.res.status === 405 && /POST/.test(verifyGet.res.headers.get('allow')) && nope.res.status === 404,
      'an action of a singleton, at {path}:{name}: 200 with its object, 405 with another method, 404 if undeclared (11.1)', `${verify.res.status} ${verifyGet.res.status} ${nope.res.status}`);
  }
  const shopPost = await get(`${R}/shop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(shopPost.res.status === 405 && /PATCH/.test(shopPost.res.headers.get('allow')), 'POST to the singleton gives 405 with Allow', shopPost.res.headers.get('allow'));
  const shopInclude = await get(`${R}/shop?include=x`);
  ok(shopInclude.json?.code === 'unsupported_parameter', 'include on the singleton gives unsupported_parameter');
  const shopPatch = await get(`${R}/shop`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ max_reservations: 5 }) });
  ok(shopPatch.res.status === 200 && shopPatch.json.max_reservations === 5 && shopPatch.json._etag, 'PATCH to the singleton', shopPatch.body);
  const year = await get(`${R}/books?sort=year`);
  ok(year.res.status === 200 && !year.res.headers.has('deprecation') && !year.res.headers.has('sunset') && !/rel="deprecation"/.test(year.res.headers.get('link')),
    'sorting by year, whose sort is announced in deprecations, carries no Deprecation: a notice that retires part of a resource puts nothing in its responses (5.5)');
  const latin = await get(`${R}/books`, { method: 'POST', headers: { 'content-type': 'application/json; charset=latin1' }, body: JSON.stringify({ title: 'x', price: '1.00' }) });
  ok(latin.res.status === 415, 'a POST with charset=latin1 gives 415 (3)');
  const empty = await get(`${R}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' });
  ok(empty.res.status === 400 && empty.json.code === 'bad_request', 'an empty body with application/json gives 400 (3)');
  const plainPatch = await get(`${R}/books/7`, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body: '{}' });
  ok(plainPatch.res.status === 415 && plainPatch.res.headers.get('accept-patch') === 'application/merge-patch+json', 'a PATCH as text/plain gives 415 with Accept-Patch (5.1)');
  const mine = await get(`${R}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mi-categoria', name: 'Mía' }) });
  ok(mine.res.status === 201 && mine.res.headers.get('location') === '/categories/mi-categoria', 'id_from "either": the client picks the id (5.1)', mine.body);
  const folded = await get(`${R}/categories?filter%5Bname%5D=MIA&limit=50`);
  ok(folded.res.status === 200 && folded.json.items.some((c) => c.id === 'mi-categoria'), 'collations "server": name=MIA finds "Mía", ignoring case and accents (6.1)', folded.body.slice(0, 200));
  await fetch(`${R}/categories/mi-categoria`, { method: 'DELETE' });
  const again = await get(`${R}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mi-categoria', name: 'Otra' }) });
  ok(again.res.status === 409 && again.json.errors?.[0]?.code === 'taken', 'the id of a deleted item gives 409 taken', again.body);
  const bookId = await get(`${R}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x', title: 'x', price: '1.00' }) });
  ok(bookId.res.status === 422 && bookId.json.errors?.some((e) => e.pointer === '/id' && e.code === 'read_only'), 'without id_from, a POST with an id gives 422 read_only at /id');
  const key = (k) => ({ 'content-type': 'application/json', 'idempotency-key': `"${k}"` });
  await get(`${R}/books?origen=a`, { method: 'POST', headers: key('q-1'), body: JSON.stringify({ title: 'Q', price: '1.00' }) });
  const otherQuery = await get(`${R}/books?origen=b`, { method: 'POST', headers: key('q-1'), body: JSON.stringify({ title: 'Q', price: '1.00' }) });
  ok(otherQuery.res.status === 422 && otherQuery.json.code === 'idempotency_mismatch', 'the same key with another query gives 422 idempotency_mismatch (7.1)');
  const pct = await get(`${R}/books/%37`);
  ok(pct.res.status === 200 && pct.json.id === '7', '/books/%37 is /books/7 (3)');

  console.log('Discovery by URL');
  await mock('http://localhost:8830/', 8832, '--count', 'books=7');
  const byUrl = await get('http://localhost:8832/books?count=true');
  ok(byUrl.json.total === 7, '--count books=7 applies to that collection', byUrl.body);
  const products = await get('http://localhost:8832/products?count=true');
  ok(products.json.total === 50, 'and the others keep the default');

  console.log('Own discovery: dates, durations, booleans, relations, linked schema');
  const agenda = await mock(AGENDA, 8833);
  const ag = check('http://localhost:8833/');
  console.log(`  restep-check against the agenda mock:     ${ag.summary}`);
  ok(ag.code === 0 && /^0 failed/.test(ag.summary), 'restep-check --writes passes with no failures', ag.fails.join('\n        '));
  const doc = (await get('http://localhost:8833/')).json;
  // Since 0.3.0 the mock simulates actions: they are served; sync is still not simulated and is removed.
  ok(!doc.profiles.includes('sync') && JSON.stringify(doc.extensions) === '["actions"]' && doc.collections.talks.actions?.cancel && !doc.collections.speakers.sync,
    'removes from discovery what it does not implement (sync) and serves what it does (actions)', JSON.stringify(doc.extensions));
  ok(/Not implemented: sync/.test(agenda.stderrText()), 'and warns about it on standard error');
  const schema = await get('http://localhost:8833/schemas/venue.json');
  ok(schema.res.status === 200 && schema.json.properties.capacity.minimum === 20, 'serves the linked schema at its path');
  const venues = (await get('http://localhost:8833/venues?limit=50')).json.items;
  ok(venues.every((v) => v.capacity >= 20 && v.capacity <= 1200), 'respects the schema minimum and maximum when generating');
  const bigVenue = await get('http://localhost:8833/venues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sala grande', capacity: 5000 }) });
  ok(bigVenue.res.status === 422 && bigVenue.json.errors.some((e) => e.pointer === '/capacity' && e.code === 'range'), 'and validates them on write (422 range)');
  const speakers = (await get('http://localhost:8833/speakers?limit=25')).json.items;
  ok(speakers.every((s) => /^[a-z]+\.[a-z]+\d+@example\.com$/.test(s.email)), 'emails look like emails', speakers[0].email);
  ok(speakers.every((s) => s.birth_date == null || /^\d{4}-\d{2}-\d{2}$/.test(s.birth_date)), 'birth_date is a date');
  ok(speakers.every((s) => typeof s.active === 'boolean' || s.active === null), 'active is a boolean');
  const talk = await get('http://localhost:8833/talks/2?include=venue,speakers&fields=title,venue.name,speakers.email');
  ok(talk.res.status === 200 && typeof talk.json.venue?.name === 'string' && talk.json._etag && Object.keys(talk.json.venue).sort().join() === 'id,name',
    'include and dotted fields return only what was asked of the included item', talk.body);
  const cg = await get('http://localhost:8833/venues?limit=2');
  ok(cg.res.headers.get('cache-groups') === '"/venues", "/venues/1", "/venues/10"', 'Cache-Groups with the collection first and then its items', cg.res.headers.get('cache-groups'));
  const noInclude = await get('http://localhost:8833/talks?fields=venue.name');
  ok(noInclude.json?.code === 'invalid_parameter' && noInclude.json.parameter === 'fields', 'dotted fields without include gives invalid_parameter');
  const deep = await get('http://localhost:8833/talks?include=venue.city');
  ok(deep.json?.code === 'unsupported_parameter', 'include deeper than include_depth gives unsupported_parameter');
  const years = await get('http://localhost:8833/talks?filter%5Bduration%5D%5Ble%5D=P1Y');
  ok(years.json?.code === 'invalid_parameter', 'a duration with years in a filter gives invalid_parameter');
  const late = await get('http://localhost:8833/talks?filter%5Bstarts_at%5D%5Bge%5D=2026-01-01T00:00:00%2B01:00&limit=30');
  ok(late.res.status === 200 && late.json.items.every((x) => Date.parse(x.starts_at) >= Date.parse('2025-12-31T23:00:00Z')), 'datetimes compare as instants, with offset');

  console.log('Seed');
  const dump = (...a) => spawnSync(process.execPath, [MOCK, AGENDA, '--dump', '--quiet', ...a], { encoding: 'utf8' }).stdout;
  ok(dump('--seed', '7') === dump('--seed', '7'), 'same seed, same data');
  ok(dump('--seed', '7') !== dump('--seed', '8'), 'another seed, other data');

  console.log('Simulated failures and latency');
  const failing = await mock(AGENDA, 8834, '--fail-rate', '1', '--retry-after', '3', '--quiet');
  const down = await get('http://localhost:8834/talks');
  ok(down.res.status === 503 && down.res.headers.get('content-type') === 'application/problem+json' && down.json.code === 'unavailable'
    && down.res.headers.get('retry-after') === '3', '--fail-rate 1 gives 503 unavailable as problem+json with Retry-After');
  const health = await get('http://localhost:8834/status');
  ok(health.res.status === 200, 'the service status does not go down with the API');
  await stop(failing); // its port is reused below
  await mock(AGENDA, 8835, '--fail-rate', '0.5', '--seed', '3', '--quiet');
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await fetch('http://localhost:8835/venues')).status);
  const fails = codes.filter((c) => c === 503).length;
  ok(fails > 5 && fails < 35 && codes.every((c) => c === 200 || c === 503), `--fail-rate 0.5 fails some of them (${fails} of 40)`);
  await mock(AGENDA, 8836, '--latency', '150-200', '--quiet');
  const t0 = Date.now();
  await fetch('http://localhost:8836/venues');
  ok(Date.now() - t0 >= 150, `--latency 150-200 delays the response (${Date.now() - t0} ms)`);

  console.log('create default (4.3)');
  const withDefaults = join(tmp, 'defaults.json');
  writeFileSync(withDefaults, JSON.stringify({ restep: '1.0', profiles: ['core'], collections: { books: { path: '/books',
    schemas: { create: { type: 'object', required: ['title'], properties: {
      title: { type: 'string' }, status: { type: 'string', enum: ['draft', 'published'], default: 'draft' },
      signed: { default: false, anyOf: [{ type: 'boolean' }, { type: 'null' }] } } } } } } }));
  await mock(withDefaults, 8837, '--quiet', '--count', '0');
  const post = (body) => get('http://localhost:8837/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const made = await post({ title: 'Sin estado' });
  ok(made.res.status === 201 && made.json.status === 'draft' && made.json.signed === false, 'a POST without the field stores its default', made.body);
  const kept = await post({ title: 'Con estado', status: 'published', signed: null });
  ok(kept.res.status === 201 && kept.json.status === 'published' && (kept.json.signed ?? null) === null, 'what is sent, null included, does not take the default', kept.body);
  const listed = await get('http://localhost:8837/books');
  ok(!made.res.headers.has('cache-group-invalidation') && !listed.res.headers.has('cache-groups'),
    'without the cache profile it sends neither Cache-Groups nor Cache-Group-Invalidation (8)', [...made.res.headers.keys()].join(', '));

  console.log('Draft 6: version, extensions, singletons, expired retirements, limits');
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
  ok(doc6.restep === '1.0-draft.7' && /draft 7/.test(m6.stderrText()), 'serves "restep": "1.0-draft.7" and warns if the document said another version (1.1)', doc6.restep);
  ok(JSON.stringify(doc6.extensions) === '["inherit"]', 'announces inherit if a collection declares it, and removes batch (11.6)', JSON.stringify(doc6.extensions));
  ok(doc6.collections.notes?.parent === 'items' && !doc6.singletons.bad && doc6.singletons.me, 'serves the subcollection and leaves out the singleton with a template');
  ok(!doc6.collections.items.sort.includes('title') && JSON.stringify(doc6.collections.items.filter.price.ops) === '["eq"]',
    'an expired sort or operator retirement applies: it is no longer declared (5.5)', JSON.stringify(doc6.collections.items));
  ok((doc6.deprecations ?? []).some((d) => d.kind === 'reason') && (doc6.collections.items.deprecations ?? []).some((d) => d.kind === 'field')
    && (doc6.collections.items.deprecations ?? []).some((d) => d.kind === 'sort'),
    'keeps every expired notice in deprecations, also those it cannot simulate (field, reason) (5.5)');
  const sorted = await get('http://localhost:8838/items?sort=title');
  ok(sorted.json?.code === 'unsupported_parameter', 'sorting by what was retired gives unsupported_parameter');
  const gone = await get('http://localhost:8838/old');
  ok(gone.res.status === 410 && gone.json.code === 'retired', 'a retired collection gives 410 retired');
  const me = await get('http://localhost:8838/me');
  ok(me.res.status === 200 && me.res.headers.get('content-type') === 'application/json', 'a singleton without a schema answers with an object');
  const noMax = await get('http://localhost:8838/items?limit=2');
  ok(noMax.json?.code === 'unsupported_parameter' && noMax.json.parameter === 'limit', 'limit without a declared max_limit gives unsupported_parameter (6.4)');
  const noCount = await get('http://localhost:8838/items?count=false');
  ok(noCount.json?.code === 'unsupported_parameter', 'count=false without a declared count gives unsupported_parameter (6.5)');
  const anon = await get('http://localhost:8838/items', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"a-1"' }, body: '{}' });
  ok(anon.res.status === 400 && anon.json.errors?.[0]?.header === 'Idempotency-Key', '"anonymous": false: a key without credentials gives 400 with an entry for the header (7.1)', anon.body);
  const malformed = await get('http://localhost:8838/items', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"a"; p=1', authorization: 'Bearer x' }, body: '{}' });
  ok(malformed.res.status === 400 && malformed.json.errors?.[0]?.header === 'Idempotency-Key', 'a key with parameters gives 400 with an entry for the header');

  console.log('Subcollections, actions and relations (test/biblioteca.json)');
  const lib = await mock(LIBRARY, 8839, '--count', 'authors=6', '--count', 'shelves=6');
  const L = 'http://localhost:8839';
  const libCheck = check(`${L}/`);
  console.log(`  restep-check against the library mock:    ${libCheck.summary}`);
  ok(libCheck.code === 0 && /^0 failed/.test(libCheck.summary), 'restep-check --writes passes with no failures', libCheck.fails.join('\n        '));
  const libDoc = (await get(`${L}/`)).json;
  const err = lib.stderrText();
  ok(libDoc.collections.books?.parent === 'authors' && libDoc.collections.reviews?.parent === 'books' && !libDoc.collections.orphans,
    'serves the subcollections (two levels) and leaves out the one hanging from something that does not exist', Object.keys(libDoc.collections).join());
  ok(JSON.stringify(libDoc.extensions) === '["actions"]' && libDoc.collections.books.actions.reserve && !libDoc.collections.books.actions.changes
    && !libDoc.collections.shelves.actions.broken, 'serves actions and removes those the text forbids (changes, unsafe GET)');
  ok(!libDoc.collections.shelves.filter['books.id'] && libDoc.collections.shelves.filter['featured.id'] && /6\.1/.test(err),
    'removes from filter the path through a to-many relation (6.1), and warns');
  const books1 = await get(`${L}/authors/1/books?limit=20`);
  ok(books1.res.status === 200 && books1.json.items.length === 3 && books1.json.items[0].id === '1', 'each parent has its own items (3 by default), with their own ids', books1.body.slice(0, 120));
  ok((await get(`${L}/authors/999/books`)).res.status === 404 && (await get(`${L}/authors/999/books/1`)).res.status === 404, '404 if the parent does not exist');
  const rv = await get(`${L}/authors/2/books/1/reviews`);
  ok(rv.res.status === 200 && Array.isArray(rv.json.items), 'a second level: /authors/2/books/1/reviews');
  const book = await get(`${L}/authors/2/books/1`);
  const withReviews = await get(`${L}/authors/2/books/1?include=reviews`);
  ok(!('reviews' in book.json) && Array.isArray(withReviews.json.reviews) && withReviews.json.reviews.length === rv.json.items.length
    && withReviews.json.reviews.every((r) => r.href === `/authors/2/books/1/reviews/${r.id}` && typeof r.stars === 'number'),
    'the relation to the subcollection is not embedded; with include it brings its items, with href (9)', JSON.stringify(withReviews.json.reviews));
  const withBest = (await get(`${L}/authors/2/books?limit=20`)).json.items.filter((b) => b.best_review);
  ok(withBest.length && withBest.every((b) => /^\/authors\/[^/]+\/books\/[^/]+\/reviews\/[^/]+$/.test(b.best_review.href)),
    'a link to a subcollection hanging from the collection itself is generated too, with href', JSON.stringify(withBest[0]?.best_review));
  const nb = await get(`${L}/authors/2/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Nuevo', year: 2020 }) });
  ok(nb.res.status === 201 && nb.res.headers.get('location') === '/authors/2/books/4', 'POST to a subcollection: Location with the parent path', nb.res.headers.get('location'));
  const back = await get(`${L}/authors/2/books/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(book.json) });
  ok(back.res.status === 200 && back.json._etag === book.json._etag, 'sending the item back as read changes nothing (not even its ETag)');
  const forged = await get(`${L}/authors/2/books/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ reviews: [{ id: 'x', href: '/authors/2/books/1/reviews/x' }] }) });
  ok(forged.res.status === 422 && forged.json.errors[0].code === 'read_only', 'that relation is not writable: another value gives read_only', forged.body);
  const sh = (await get(`${L}/shelves/1`)).json;
  ok((sh.books ?? []).every((b) => typeof b.href === 'string' && /^\/authors\/[^/]+\/books\/[^/]+$/.test(b.href)), 'a link to a subcollection item carries href (3)', JSON.stringify(sh.books));
  const patchShelf = (books) => get(`${L}/shelves/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ books }) });
  let r = await patchShelf([{ id: '1' }]);
  ok(r.res.status === 422 && r.json.errors[0].pointer === '/books/0/href', 'linking without href gives 422 at /books/0/href', r.body);
  r = await patchShelf([{ id: '2', href: '/authors/3/books/1' }]);
  ok(r.res.status === 422 && r.json.errors[0].pointer === '/books/0/href', 'an href whose last segment is not the id gives 422');
  r = await patchShelf([{ id: '9', href: '/authors/3/books/9' }]);
  ok(r.res.status === 422 && r.json.errors[0].pointer === '/books/0/id' && r.json.errors[0].code === 'unknown', 'an item that does not exist gives unknown at its id');
  r = await patchShelf([{ id: '1', href: '/authors/3/books/1', extra: 1 }]);
  ok(r.res.status === 200 && JSON.stringify(r.json.books) === '[{"id":"1","href":"/authors/3/books/1"}]', 'with its href it links, and only id and href are stored', r.body);
  const inc = await get(`${L}/shelves/1?include=books&fields=label,books.title`);
  ok(inc.res.status === 200 && inc.json.books[0].title && inc.json.books[0].href === '/authors/3/books/1' && !('year' in inc.json.books[0]),
    'include of a subcollection item fills it in, keeps href, and dotted fields projects', inc.body);
  ok((await get(`${L}/shelves/1?include=books&fields=books.nope`)).json?.code === 'invalid_parameter', 'fields with a field the included item lacks gives invalid_parameter');
  ok((await get(`${L}/shelves?include=featured.books`)).res.status === 400, 'include that goes on through a polymorphic relation gives 400');
  const poly = (await get(`${L}/shelves?include=featured&limit=50`)).json.items.find((x) => x.featured);
  ok(poly && typeof poly.featured.type === 'string' && Object.keys(poly.featured).length > 2, 'include of a polymorphic relation fills in the item of its type', JSON.stringify(poly?.featured));
  await fetch(`${L}/authors/3`, { method: 'DELETE' });
  ok((await get(`${L}/authors/3/books`)).res.status === 404 && (await get(`${L}/shelves/1`)).json.books.length === 0,
    'deleting the parent deletes its subcollection and the links to its items');

  console.log('Actions (11.1)');
  const act = (path, init = {}) => get(`${L}${path}`, { method: 'POST', ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  r = await act('/authors/1/books/1:reserve', { body: '{}' });
  ok(r.res.status === 422 && r.json.errors.some((e) => e.pointer === '/hours' && e.code === 'required'), 'validates the body against its input: 422 required', r.body);
  r = await act('/authors/1/books/1:reserve', { body: JSON.stringify({ hours: 99, extra: true }) });
  ok(r.res.status === 422 && r.json.errors.some((e) => e.code === 'range') && r.json.errors.some((e) => e.code === 'unknown'), 'range and unknown from the schema');
  r = await act('/authors/1/books/1%3Areserve', { body: JSON.stringify({ hours: 3 }) });
  ok(r.res.status === 200 && r.json.id === '1' && r.json._etag === r.res.headers.get('etag'), 'answers with the affected item (200), also with %3A', r.body);
  ok((await act('/authors/1/books/999:reserve', { body: JSON.stringify({ hours: 3 }) })).res.status === 404, '404 if the item does not exist');
  ok((await act('/authors/1/books:reserve', { body: '{}' })).res.status === 404, '404 if the action is an item action and is called on the collection');
  ok((await act('/authors/1/books/1:nope', { body: '{}' })).res.status === 404, '404 if the action is not declared');
  r = await get(`${L}/authors/1/books/1:reserve`);
  ok(r.res.status === 405 && r.res.headers.get('allow') === 'POST', 'another method gives 405 with Allow');
  r = await act('/authors/1/books/1:reserve', { body: JSON.stringify({ hours: 3 }), headers: { 'content-type': 'text/plain' } });
  ok(r.res.status === 415, 'a body that is not application/json gives 415');
  const k = { 'idempotency-key': '"accion-1"' };
  const first = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 4 }), headers: k });
  const again2 = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 4 }), headers: k });
  ok(first.res.status === 200 && again2.res.headers.get('idempotent-replayed') === 'true' && again2.body === first.body, 'not idempotent: the same key replays the stored response (7.1)');
  r = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 5 }), headers: k });
  ok(r.res.status === 422 && r.json.code === 'idempotency_mismatch', 'and with another body gives idempotency_mismatch');
  // 5.4 rule 3 and 7.1: once the book is deleted, the repeat still answers (not 404), with the same status and without
  // body or ETag; another key does give 404.
  r = await get(`${L}/authors/1/books/2`, { method: 'DELETE' });
  ok(r.res.status === 204, 'the book with the stored action can be deleted', r.body);
  r = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 4 }), headers: k });
  ok(r.res.status === 200 && r.res.headers.get('idempotent-replayed') === 'true' && r.body === '' && !r.res.headers.get('etag'),
    'a replay after the item was deleted keeps the status, without body or ETag', `${r.res.status} ${r.body}`);
  r = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 4 }), headers: { 'idempotency-key': '"accion-2"' } });
  ok(r.res.status === 404, 'another key on the deleted item gives 404', `${r.res.status}`);
  r = await act('/authors/1/books/2:reserve', { body: JSON.stringify({ hours: 5 }), headers: { 'idempotency-key': 'sin-comillas' } });
  ok(r.res.status === 400 && r.json.errors?.[0]?.header === 'Idempotency-Key', 'a malformed key gives 400');
  r = await get(`${L}/shelves:reorder`, { method: 'POST', headers: { 'content-type': 'text/plain', 'idempotency-key': '"x"' } });
  ok(r.res.status === 204, 'idempotent collection action: an empty body with any type is {}, the key is not refused, and it answers 204');
  r = await get(`${L}/authors/1/books/1:preview`);
  ok(r.res.status === 200 && r.json.id === '1' && r.res.headers.get('cache-control'), 'a GET action answers with the item');
  r = await get(`${L}/shelves:summary`);
  ok(r.res.status === 204 && r.body === '', 'a safe collection GET action without output answers 204 (11.1)', `${r.res.status}`);
  ok((await get(`${L}/shelves:summary?limit=2`)).json?.code === 'unsupported_parameter', 'a reserved parameter on an action gives unsupported_parameter');
  const tag = (await get(`${L}/authors/1/books/1`)).res.headers.get('etag');
  r = await act('/authors/1/books/1:reserve', { body: JSON.stringify({ hours: 1 }), headers: { 'if-match': '"otra"' } });
  ok(r.res.status === 412 && tag, 'If-Match against the item: 412 with another ETag (7.2)');

  console.log('Links to subcollections and collections without GET (4.3, 9)');
  // A book highlights one of its reviews; a list picks a review of any book; suggestions only
  // allow POST.
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
    'a book highlight is a review of that same book, not of another parent', JSON.stringify(highlights.map((b) => [b.id, b.highlight.href])));
  ok(highlights.every((b) => typeof b.highlight.reply_to !== 'undefined' && 'reply_to' in b.highlight), 'include of a to-one relation whose target is a subcollection fills it in (9)', JSON.stringify(highlights[0]));
  const replies = (await Promise.all(shelf.map((b) => get(`${E}/books/${b.id}/reviews?limit=50`)))).flatMap((x, n) => x.json.items.map((r) => [shelf[n].id, r]));
  ok(replies.filter(([, r]) => r.reply_to).every(([b, r]) => r.reply_to.href.startsWith(`/books/${b}/reviews/`)), 'a review replies to another of the same book');
  const picks = (await get(`${E}/lists?include=pick&limit=50`)).json.items.filter((l) => l.pick);
  ok(picks.length && picks.every((l) => typeof l.pick.reply_to !== 'undefined' && /^\/books\/[^/]+\/reviews\/[^/]+$/.test(l.pick.href)),
    'from a top-level collection, include also fills in the subcollection item', JSON.stringify(picks[0]));
  const head = await fetch(`${E}/suggestions`, { method: 'HEAD' });
  ok(head.status === 405 && head.headers.get('allow') === 'POST', 'without a declared GET, HEAD gives 405 and Allow lists only the declared methods (4.3)', `${head.status} Allow: ${head.headers.get('allow')}`);
  const getNo = await get(`${E}/suggestions`);
  ok(getNo.res.status === 405 && getNo.res.headers.get('allow') === 'POST', 'and GET also gives 405 with Allow: POST', getNo.res.headers.get('allow'));
  // 6.2 and 5.3: books declares no sort, so sort=id is not implemented (even though the default order is by id).
  const noSort = await get(`${E}/books?sort=id`);
  ok(noSort.res.status === 400 && noSort.json?.code === 'unsupported_parameter' && noSort.json.parameter === 'sort',
    'without a declared sort, sort=id gives unsupported_parameter with parameter sort (6.2)', noSort.body);
  const plain = (await get(`${E}/books?limit=50`)).json.items.map((b) => b.id);
  ok(plain.length > 1 && plain.join() === [...plain].sort((a, b) => Number(a) - Number(b)).join(), 'and without sort the collection keeps its default order, by id', plain.join());
  const linkedCheck = check(E);
  ok(linkedCheck.code === 0 && /^0 failed/.test(linkedCheck.summary) && /core\.methods\.left-out/.test(spawnSync(process.execPath, [CHECKER, E, '--verbose'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).stdout),
    'restep-check --writes passes with no failures, with suggestions without GET (core.methods.left-out)', linkedCheck.fails.join('\n        '));

  console.log('Draft 7: localized fields, new operators, quantifier, default and required filters, upsert, upload, actions, child singletons');
  {
    const future = '2099-01-01T00:00:00Z';
    const d7 = join(tmp, 'draft7.json');
    writeFileSync(d7, JSON.stringify({
      restep: '1.0-draft.7', default_language: 'es', profiles: ['core', 'query', 'writes', 'relations'], extensions: ['actions'], shared_cache: {},
      deprecations: [{ kind: 'collection', name: 'reviews', announced: '2026-01-02T03:04:05Z', sunset: future }],
      collections: {
        books: {
          path: '/books', id_from: 'client', reusable_ids: true, upsert: true, shared_cache: {}, 'x-mock-server-only': ['created_at', 'id', 'nope'],
          schemas: { item: { type: 'object', properties: {
            id: { type: 'string' }, title: { type: 'string' }, name_i18n: { type: 'object', additionalProperties: { type: 'string' } },
            name: { type: ['string', 'null'], readOnly: true }, formats: { type: 'array', items: { type: 'string', enum: ['pdf', 'epub', 'paper'] } },
            created_at: { type: 'string', format: 'date-time', readOnly: true }, starts_local: { type: 'string' }, zone: { type: 'string' },
            length: { type: 'string', format: 'duration' }, reviews: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } } },
          language_maps: { name_i18n: {} }, localized: { name: { source: 'name_i18n' } }, local_times: { starts_local: { zone: 'zone' } },
          relations: { reviews: { to: 'reviews', many: true } },
          filter: {
            title: { type: 'string', ops: ['eq', 'prefix', 'contains', 'nin', 'regex'] },
            name: { type: 'string', ops: ['eq', 'prefix'] },
            formats: { type: 'enum', values: ['pdf', 'epub', 'paper'], ops: ['eq', 'in', 'ne'], quantifier: 'some' },
            'reviews.rating': { type: 'integer', ops: ['eq', 'ge', 'null'], quantifier: 'some' },
            reviews: { type: 'string', ops: ['null'] },
            created_at: { type: 'datetime', ops: ['ge'] }, length: { type: 'duration', ops: ['ge', 'lt'] }, starts_local: { type: 'localdatetime', ops: ['ge'] },
          },
          named_filters: { active: { description: 'Not archived.', default: true } },
          sort: ['name', 'reviews.rating', 'title'], max_limit: 100, count: 'exact',
          deprecations: [{ kind: 'field', name: 'title', announced: '2026-01-02T03:04:05Z', sunset: future }],
          actions: {
            compare: { on: 'item', safe: true, idempotent: true, method: 'GET', params: { with: { type: 'string', required: true } },
              output: { type: 'object', properties: { fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } } },
            new: { on: 'collection', safe: true, idempotent: true, method: 'GET' },
            touch: { on: 'item', safe: false, idempotent: false },
            odd: { on: 'item', safe: true, idempotent: false },
          },
        },
        reviews: { path: '/reviews', max_limit: 100, schemas: { item: { type: 'object', properties: { id: { type: 'string' }, rating: { type: 'integer', minimum: 1, maximum: 5 } } } } },
        files: { path: '/files', upload: { media_types: ['image/*', 'application/pdf'], max_size: 1000, multipart: true },
          schemas: { item: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, media_type: { type: 'string' } } } } },
        readers: { path: '/readers' },
        docs: { path: '/docs', upload: { media_types: ['application/pdf'] },
          schemas: { create: { type: 'object', properties: { title: { type: 'string' } } }, item: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } } },
        blobs: { path: '/blobs', upload: { media_types: ['application/json'] } },
        anyfiles: { path: '/anyfiles', upload: { media_types: ['*/*'] } },
        appfiles: { path: '/appfiles', upload: { media_types: ['application/*'] } },
        imgfiles: { path: '/imgfiles', upload: { media_types: ['image/*'] } },
        ldmixed: { path: '/ldmixed', upload: { media_types: ['application/ld+json'] },
          schemas: { create: { type: 'object', properties: { title: { type: 'string' } } }, item: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } } },
        mixed: { path: '/mixed', upload: { media_types: ['application/*'] },
          schemas: { create: { type: 'object', properties: { title: { type: 'string' } } }, item: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } } },
        runs: { path: '/runs', max_limit: 100, schemas: { item: { type: 'object', properties: { id: { type: 'string' }, local: { type: 'string' },
          stamped: { type: 'string', readOnly: true } } } }, 'x-mock-server-only': ['stamped'],
          filter: { local: { type: 'localdatetime', ops: ['ge'] }, stamped: { type: 'localdatetime', ops: ['ge'] } },
          actions: { probe: { on: 'collection', safe: true, idempotent: true, method: 'GET', params: { n: { type: 'integer' }, ns: { type: 'integer', list: true }, x: { type: 'number' } },
            output: { type: 'object' } } } },
        shelves: { path: '/shelves', max_limit: 100, relations: { books: { to: 'books', many: true } },
          schemas: { item: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' }, at: { type: 'string', format: 'date-time' },
            rank: { type: 'integer', readOnly: true }, labels: { type: 'array', items: { type: 'string' } },
            times: { type: 'array', items: { type: 'string', format: 'date-time' } }, books: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } } },
          filter: { n: { type: 'integer', ops: ['eq', 'ge', 'in'] }, books: { type: 'integer', ops: ['null'], quantifier: 'some' }, labels: { type: 'string', ops: ['null'], quantifier: 'some' },
            'books.id': { type: 'string', ops: ['eq', 'null'], quantifier: 'some' } } },
        cats: { path: '/cats', relations: { parent: { to: 'cats' } },
          schemas: { item: { type: 'object', properties: { id: { type: 'string' }, parent: { type: ['object', 'null'], properties: { id: { type: 'string' } } },
            shelf: { type: 'object', properties: { floor: { type: 'integer' }, section: { type: 'string' } } },
            shelf_own: { type: ['object', 'null'], properties: { floor: { type: 'integer' }, section: { type: 'string' } } }, takes: { type: 'boolean' } } } },
          inherit: { shelf: { own: 'shelf_own', from: ['parent'], combine: 'fields', switch: { field: 'takes', initial: true } } } },
        editions: { path: '/editions', filter: { isbn: { type: 'string', ops: ['eq'], required: true } }, inherit_items: { from: ['x'] } },
      },
      singletons: {
        settings: { path: '/readers/{reader_id}/settings', parent: 'readers', methods: ['GET', 'PATCH'], method_effects: { PATCH: [], DELETE: ['destroys'] },
          schemas: { item: { type: 'object', properties: { theme: { type: 'string', enum: ['light', 'dark'] } } } } },
        summary: { path: '/books/{book_id}/summary', parent: 'books', method_effects: { PATCH: [] } },
        orphan: { path: '/x/{id}/y' },
        featured: { path: '/books/featured' },
      },
    }));
    const m7 = await mock(d7, 8828, '--count', '30');
    const B = 'http://localhost:8828';
    const doc = (await get(`${B}/`)).json;
    ok(doc.restep === '1.0-draft.7' && doc.default_language === 'es' && !('shared_cache' in doc) && !('shared_cache' in doc.collections.books),
      'serves draft 7, keeps default_language and removes shared_cache, which is reserved (4.2)');
    ok(!doc.collections.editions.inherit_items && /inherit_items/.test(m7.stderrText()), 'removes inherit_items, which it does not simulate, with a warning (11.6)');
    ok(JSON.stringify(doc.collections.books.filter.title.ops) === '["eq","prefix","contains","nin"]' && JSON.stringify(doc.collections.books.filter.formats.ops) === '["eq","in"]',
      'does not serve an operator outside 6.1 (regex) nor ne on a path with quantifier (6.1)', JSON.stringify(doc.collections.books.filter));
    ok(doc.singletons.settings && doc.singletons.summary && !doc.singletons.orphan && !doc.singletons.featured,
      'serves singletons that hang from an item and leaves out a template without parent and a path an item could have (5.9)', Object.keys(doc.singletons).join(','));
    ok(doc.collections.books.actions.compare && doc.collections.books.actions.new && !doc.collections.books.actions.odd,
      'leaves out a safe action that is not idempotent (11.1)');

    // 3 and 5.6: localized fields.
    const en = await get(`${B}/books/1`, { headers: { 'accept-language': 'en' } });
    const es = await get(`${B}/books/1`, { headers: { 'accept-language': 'es-ES, en;q=0.5' } });
    const xx = await get(`${B}/books/1`, { headers: { 'accept-language': 'fr' } });
    ok(en.json.name === (en.json.name_i18n.en ?? null) && es.json.name === (es.json.name_i18n.es ?? null) && xx.res.headers.get('content-language') === 'es',
      'a localized field is the text of its map in the language of the response; without a match, the default language (5.6)', `${en.json.name} / ${es.json.name}`);
    ok(en.res.headers.get('content-language') === 'en' && /Accept-Language/.test(en.res.headers.get('vary') ?? '') && en.res.headers.get('etag') !== es.res.headers.get('etag')
      && en.json._etag === en.res.headers.get('etag'), 'with Content-Language and Vary, and an ETag that differs by language (5.6, 7.2)');
    let r = await get(`${B}/books/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json', 'if-match': en.res.headers.get('etag'), 'accept-language': 'es' },
      body: JSON.stringify({ title: 'Otra', name: en.json.name }) });
    ok(r.res.status === 200 && r.json.title === 'Otra', 'If-Match with the ETag of another language succeeds, and the localized field with its text in any language is ignored (5.1, 7.2)', r.body);
    r = await get(`${B}/books/1`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ name: 'No es ninguno' }) });
    ok(r.res.status === 422 && r.json.errors?.[0]?.code === 'read_only' && r.json.errors[0].pointer === '/name', 'another value of a localized field gives read_only (5.1)', r.body);
    const byName = await get(`${B}/books?sort=name&limit=100&filter[active]=false`, { headers: { 'accept-language': 'en' } });
    const names = byName.json.items.map((x) => x.name).filter((x) => x != null);
    ok(names.every((x, i) => i === 0 || [...names[i - 1]].map((c) => c.codePointAt(0)).join() <= [...x].map((c) => c.codePointAt(0)).join() || names[i - 1] <= x)
      && byName.json.items.slice(names.length).every((x) => x.name == null), 'sorting by a localized field uses the language of the response, without value last (6.2)');
    const curEn = await get(`${B}/books?limit=2`, { headers: { 'accept-language': 'en' } });
    r = await get(`${B}${curEn.json.next}`, { headers: { 'accept-language': 'es' } });
    ok(r.res.status === 400 && r.json.parameter === 'cursor', 'the cursor is bound to the language (6.4)', `${r.res.status}`);

    // 6.1: new operators and quantifier.
    const all = (await get(`${B}/books?limit=100&filter[active]=false`)).json.items;
    const word = all.find((x) => x.title)?.title.split(' ')[0];
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[title][prefix]=${encodeURIComponent(word)}`);
    ok(r.json.items.length && r.json.items.every((x) => x.title.startsWith(word)) && r.json.items.length === all.filter((x) => x.title?.startsWith(word)).length, 'prefix (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[title][contains]=a`);
    ok(r.json.items.length === all.filter((x) => x.title?.includes('a')).length, 'contains, by code points (6.1)');
    r = await get(`${B}/books?filter[title][prefix]=`);
    ok(r.res.status === 400 && r.json.code === 'invalid_parameter', 'an empty operand of prefix gives invalid_parameter (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[title][nin]=${encodeURIComponent(all[0].title)}`);
    ok(r.json.items.length === all.filter((x) => x.title != null && x.title !== all[0].title).length, 'nin: none of the values, and never an absent one (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[formats]=pdf`);
    ok(r.json.items.length > 0 && r.json.items.every((x) => x.formats.includes('pdf')) && r.json.items.length === all.filter((x) => x.formats?.includes('pdf')).length,
      'a list field with quantifier: some element matches (6.1)');
    const reviews = Object.fromEntries((await get(`${B}/reviews?limit=50`)).json.items.map((x) => [x.id, x.rating]));
    const ratings = (b) => (b.reviews ?? []).map((x) => reviews[x.id]).filter((x) => x != null);
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[reviews.rating][ge]=4`);
    ok(r.json.items.length === all.filter((b) => ratings(b).some((x) => x >= 4)).length, 'a path through a to-many relation: some related item matches (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[reviews.rating]=5&filter[reviews][null]=true`);
    ok(r.json.items.length === all.filter((b) => !ratings(b).includes(5)).length, 'null=true on the relation negates its group: no five-star review (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[reviews][null]=true`);
    ok(r.json.items.every((b) => !(b.reviews ?? []).length) && r.json.items.length === all.filter((b) => !(b.reviews ?? []).length).length, 'null=true alone: no related item (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&sort=reviews.rating`);
    const mins = r.json.items.map((b) => (ratings(b).length ? Math.min(...ratings(b)) : null));
    ok(mins.every((x, i) => i === 0 || x === null || (mins[i - 1] !== null && mins[i - 1] <= x)), 'sort by a to-many path: the least related value ascending, without any last (6.2)', mins.join());
    r = await get(`${B}/books?filter[created_at][ge]=2020-01-01t00:00:00z`);
    ok(r.res.status === 200, 'an instant in lowercase is accepted (3)', r.body.slice(0, 200));
    r = await get(`${B}/books?filter[created_at][ge]=2020-01-01T23:59:60Z`);
    ok(r.res.status === 400 && r.json.code === 'invalid_parameter', 'a leap second gives invalid_parameter (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[length][ge]=pt1.5s`);
    const r2 = await get(`${B}/books?limit=100&filter[active]=false&filter[length][ge]=PT1.500S`);
    ok(r.res.status === 200 && JSON.stringify(r.json.items) === JSON.stringify(r2.json.items), 'durations with a fraction compare exactly, and lowercase is accepted (3, 6.1)');
    r = await get(`${B}/books?filter[length][lt]=P1Y`);
    ok(r.res.status === 400 && r.json.code === 'invalid_parameter', 'a duration with years gives invalid_parameter (6.1)');
    r = await get(`${B}/books?limit=100&filter[active]=false&filter[starts_local][ge]=2026-06-01T00:00:00`);
    ok(r.res.status === 200 && r.json.items.every((x) => x.starts_local >= '2026-06-01T00:00:00') && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(all[0].starts_local)
      && all.every((x) => x.zone == null || /^[A-Za-z]+(\/[A-Za-z_]+)*$/.test(x.zone)), 'local date-times compare as wall-clock times; zones are IANA names (3, 6.1)');

    // 6.1: default and required filters.
    const withDefault = (await get(`${B}/books?limit=100&count=true`)).json, off = (await get(`${B}/books?limit=100&count=true&filter[active]=false`)).json;
    ok(withDefault.total < off.total && off.total === 30, 'a default switch applies unless filter[name]=false turns it off (6.1)', `${withDefault.total} / ${off.total}`);
    const hidden = off.items.find((x) => !withDefault.items.some((y) => y.id === x.id));
    ok((await get(`${B}/books/${hidden.id}`)).res.status === 200, 'a default filter never applies to reading an item by its path (6.1)');
    r = await get(`${B}/books?filter[active]=true`);
    ok(r.res.status === 400 && r.json.code === 'invalid_parameter', 'any other value of a default switch gives invalid_parameter (6.1)');
    r = await get(`${B}/editions`);
    ok(r.res.status === 400 && r.json.code === 'invalid_parameter' && r.json.parameter === 'filter[isbn]', 'a list request without a required filter gives invalid_parameter naming it (6.1)', r.body);
    ok((await get(`${B}/editions?filter[isbn]=1`)).res.status === 200, 'and with it, 200');

    // 5.1: read-only fields in a POST, duplicate names, upsert, reusable_ids.
    const json = { 'content-type': 'application/json' };
    r = await get(`${B}/books`, { method: 'POST', headers: json, body: JSON.stringify({ id: 'b-1', title: 'Uno', created_at: '1999-01-01T00:00:00Z', name: null }) });
    ok(r.res.status === 201 && r.json.created_at == null, 'in a POST, a field only the server sets is ignored whatever its value (5.1)', r.body);
    r = await get(`${B}/books`, { method: 'POST', headers: json, body: '{"id": "b-2", "title": "a", "title": "b"}' });
    ok(r.res.status === 400 && r.json.code === 'bad_request', 'a body with duplicate member names gives 400 (3)', r.body);
    const del = await get(`${B}/books/b-1`, { method: 'DELETE' });
    r = await get(`${B}/books`, { method: 'POST', headers: json, body: JSON.stringify({ id: 'b-1', title: 'Uno' }) });
    ok(del.res.status === 204 && r.res.status === 201, 'with reusable_ids, the id of a deleted item is free again (5.1)', `${del.res.status} ${r.body}`);
    const first = (await get(`${B}/books/b-1`)).res.headers.get('etag');
    await get(`${B}/books/b-1`, { method: 'DELETE' });
    await get(`${B}/books`, { method: 'POST', headers: json, body: JSON.stringify({ id: 'b-1', title: 'Uno' }) });
    ok((await get(`${B}/books/b-1`)).res.headers.get('etag') !== first, 'each incarnation of an id has another ETag (5.1)');
    const patch = { 'content-type': 'application/merge-patch+json' };
    r = await get(`${B}/books/u-1`, { method: 'PATCH', headers: { ...patch, 'if-none-match': '*' }, body: JSON.stringify({ title: 'Nuevo' }) });
    ok(r.res.status === 201 && r.res.headers.get('location') === '/books/u-1' && r.json.id === 'u-1' && r.json.title === 'Nuevo', 'upsert: a PATCH to a free id creates the item (5.1)', r.body);
    r = await get(`${B}/books/u-1`, { method: 'PATCH', headers: { ...patch, 'if-none-match': '*' }, body: JSON.stringify({ title: 'Otro' }) });
    ok(r.res.status === 412, 'If-None-Match: * on an existing item gives 412 (5.1)', `${r.res.status}`);
    r = await get(`${B}/books/u-2`, { method: 'PATCH', headers: { ...patch, 'if-match': '*' }, body: JSON.stringify({ title: 'Otro' }) });
    ok(r.res.status === 412, 'If-Match: * on a free id gives 412 (5.1)', `${r.res.status}`);
    r = await get(`${B}/readers/77`, { method: 'PATCH', headers: patch, body: '{}' });
    ok(r.res.status === 404, 'without upsert, a PATCH to a free id gives 404');

    // 5.1: upload.
    r = await get(`${B}/files`, { method: 'POST', headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="a.png"' }, body: Buffer.from('0123456789') });
    ok(r.res.status === 201 && r.json._content?.media_type === 'image/png' && r.json._content.size === 10 && r.json.name === 'a.png', 'a POST with the bytes of a file creates an item with _content (5.1)', r.body);
    const bytes = await fetch(`${B}${r.json._content.href}`);
    ok(bytes.status === 200 && (await bytes.text()) === '0123456789' && bytes.headers.get('content-type') === 'image/png', 'its href gives the bytes');
    r = await get(`${B}/files`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    ok(r.res.status === 415 && r.json.code === 'unsupported_media_type', 'a media type it does not declare gives 415 (5.1)');
    r = await get(`${B}/files`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: Buffer.alloc(1001) });
    ok(r.res.status === 413 && r.json.code === 'content_too_large', 'a file larger than max_size gives 413 content_too_large (5.1)', r.body);
    const part = (name) => `--xyz\r\nContent-Disposition: form-data; name="${name}"; filename="b.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n`;
    r = await get(`${B}/files`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=xyz' }, body: `${part('file')}--xyz--\r\n` });
    ok(r.res.status === 201 && r.json._content?.media_type === 'application/pdf' && r.json._content.size === 4, 'multipart/form-data with one part named file (5.1)', r.body);
    r = await get(`${B}/files`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=xyz' }, body: `${part('file')}${part('other')}--xyz--\r\n` });
    ok(r.res.status === 415, 'any other multipart body gives 415 (5.1)', `${r.res.status}`);
    const listed = (await get(`${B}/files`)).json.items[0];
    ok(listed._content?.href === `/files/${listed.id}/content` && (await fetch(`${B}${listed._content.href}`)).status === 200, 'generated items carry _content too');

    // 11.1: params, output, new, and a 204 without ETag.
    r = await get(`${B}/books/2:compare`);
    ok(r.res.status === 400 && r.json.code === 'invalid_parameter' && r.json.parameter === 'with', 'a required parameter of a GET action that is missing gives invalid_parameter (11.1)', r.body);
    r = await get(`${B}/books/2:compare?with=3&other=1`);
    ok(r.res.status === 400 && r.json.code === 'unsupported_parameter' && r.json.parameter === 'other', 'an undeclared parameter gives unsupported_parameter (11.1)', r.body);
    r = await get(`${B}/books/2:compare?with=3`);
    ok(r.res.status === 200 && Array.isArray(r.json.fields) && !('_etag' in r.json) && !('id' in r.json), 'with output, the result has that shape and no _etag (11.1)', r.body);
    r = await get(`${B}/books:new`);
    ok(r.res.status === 200 && 'values' in r.json && 'schema' in r.json, 'GET :new gives values and schema (11.1)', r.body);
    r = await get(`${B}/books/2:touch`, { method: 'POST', headers: { prefer: 'return=minimal' } });
    ok(r.res.status === 204 && !r.res.headers.has('etag'), 'a 204 to an action carries no ETag (7.2)', `${r.res.status} ${r.res.headers.get('etag')}`);

    // 5.9: singletons that hang from an item.
    r = await get(`${B}/readers/1/settings`);
    ok(r.res.status === 200 && ['light', 'dark', null].includes(r.json.theme ?? null) && r.json._etag === r.res.headers.get('etag'), 'a singleton under an item (5.9)', r.body);
    ok((await get(`${B}/readers/999/settings`)).res.status === 404, 'under a parent item that does not exist, 404 (5.9)');
    r = await get(`${B}/readers/1/settings`, { method: 'PATCH', headers: patch, body: JSON.stringify({ theme: 'dark' }) });
    const other = await get(`${B}/readers/2/settings`, { method: 'PATCH', headers: patch, body: JSON.stringify({ theme: 'light' }) });
    ok(r.json.theme === 'dark' && (await get(`${B}/readers/1/settings`)).json.theme === 'dark' && other.json.theme === 'light', 'each parent item has its own object');
    r = await get(`${B}/readers/1/settings`, { method: 'POST', headers: json, body: '{}' });
    ok(r.res.status === 405 && !/POST/.test(r.res.headers.get('allow')) && /HEAD/.test(r.res.headers.get('allow')), 'POST gives 405, and Allow lists HEAD (4.3, 5.9)');
    ok((await get(`${B}/books/1/summary`)).res.status === 200, 'a singleton under an item of a collection with upload, actions and localized fields');

    // 11.6: combine "fields" and switch.
    const top = await get(`${B}/cats`, { method: 'POST', headers: json, body: JSON.stringify({ shelf_own: { floor: 1, section: 'A' } }) });
    const kid = await get(`${B}/cats`, { method: 'POST', headers: json, body: JSON.stringify({ parent: { id: top.json.id }, shelf_own: { section: 'B' } }) });
    ok(kid.res.status === 201 && JSON.stringify(kid.json.shelf) === '{"floor":1,"section":"B"}' && kid.json.takes === true
      && JSON.stringify(kid.json._inherited?.shelf) === `{"fields":{"floor":{"from":{"href":"/cats/${top.json.id}"}}}}`,
      'with "combine": "fields" each member resolves on its own, and _inherited lists the inherited ones; a POST gives the switch its initial value (11.6)', kid.body);
    r = await get(`${B}/cats/${kid.json.id}`, { method: 'PATCH', headers: patch, body: JSON.stringify({ takes: false }) });
    ok(JSON.stringify(r.json.shelf) === '{"section":"B"}' && !r.json._inherited?.shelf, 'while the switch is off, nothing comes from above (11.6)', r.body);
    r = await get(`${B}/cats/${kid.json.id}`, { method: 'PATCH', headers: patch, body: JSON.stringify({ shelf: r.json.shelf }) });
    ok(r.res.status === 200, 'the effective object sent back as read is ignored (5.1)', r.body);

    // 5.5: Deprecation only on resources retired whole.
    r = await get(`${B}/reviews`);
    ok(r.res.headers.get('deprecation') === `@${Date.parse('2026-01-02T03:04:05Z') / 1000}` && r.res.headers.get('sunset') === new Date(future).toUTCString(),
      'a collection retired whole carries Deprecation with announced, and Sunset (5.5)', `${r.res.headers.get('deprecation')} ${r.res.headers.get('sunset')}`);
    r = await get(`${B}/books?fields=id,title`);
    ok(!r.res.headers.has('deprecation'), 'a field notice puts nothing in the responses (5.5)');

    // Council decisions on draft 7 (round 1; round 3, 8: a null-only filter may keep quantifier "some").
    const sf = doc.collections.shelves.filter;
    ok(JSON.stringify(sf.books) === '{"type":"string","ops":["null"],"quantifier":"some"}' && JSON.stringify(sf.labels) === '{"type":"string","ops":["null"],"quantifier":"some"}'
      && !/filter\[books\] has null as its only operator/.test(m7.stderrText()) && /filter\[books\] declares type "integer"/.test(m7.stderrText()),
      'council 1 and b7 r3 8 (6.1): null on a to-many relation or a list field is served with the id or element type, keeping quantifier "some"', JSON.stringify(sf));
    const s1 = await get(`${B}/shelves`, { method: 'POST', headers: json, body: JSON.stringify({ n: 20, labels: [], books: [] }) });
    const s2 = await get(`${B}/shelves`, { method: 'POST', headers: json, body: JSON.stringify({ n: 25, labels: ['x'], books: [{ id: '2' }] }) });
    r = await get(`${B}/shelves?limit=100&filter[books][null]=true&filter[labels][null]=true`);
    ok(s1.res.status === 201 && s2.res.status === 201 && r.json.items.some((x) => x.id === s1.json.id) && !r.json.items.some((x) => x.id === s2.json.id),
      'and filter[books][null] and filter[labels][null] still work', r.body);
    r = await get(`${B}/files`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    ok(r.res.status === 415 && r.res.headers.get('accept-post') === 'image/*, application/pdf, multipart/form-data',
      'council 2 (5.1): a 415 from a collection with upload carries Accept-Post with what it takes', r.res.headers.get('accept-post'));
    r = await get(`${B}/files`, { method: 'POST', body: 'x' });
    ok(r.res.status === 415 && r.res.headers.has('accept-post'), 'also without Content-Type');
    r = await get(`${B}/files`, { method: 'POST', headers: json, body: '{"name":"x"}' });
    ok(r.res.status === 415 && r.json.code === 'unsupported_media_type' && r.res.headers.get('accept-post') === 'image/*, application/pdf, multipart/form-data',
      'with upload and no create schema it only takes files: a JSON body gives 415 (5.1)', r.body);
    r = await get(`${B}/docs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    const docJson = await get(`${B}/docs`, { method: 'POST', headers: json, body: '{"title":"Uno"}' });
    ok(r.res.status === 415 && r.res.headers.get('accept-post') === 'application/json, application/pdf' && docJson.res.status === 201 && docJson.json.title === 'Uno',
      'with a create schema it creates from JSON too, and its Accept-Post says so', `${r.res.headers.get('accept-post')} ${docJson.body}`);
    r = await get(`${B}/blobs`, { method: 'POST', headers: json, body: '{"any":1}' });
    ok(r.res.status === 201 && r.json._content?.media_type === 'application/json' && r.json._content.size === 9,
      'where media_types declares application/json and there is no create schema, a JSON body is a file', r.body);
    r = await get(`${B}/readers`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    ok(r.res.status === 415 && !r.res.headers.has('accept-post'), 'a collection without upload carries no Accept-Post');
    const nOf = async (q) => (await get(`${B}/shelves?limit=100&${q}`)).json?.items?.map((x) => x.id).sort().join();
    const twenty = await nOf('filter[n]=20');
    ok(twenty && twenty.includes(s1.json.id) && (await nOf('filter[n]=20.0')) === twenty && (await nOf('filter[n]=2e1')) === twenty && (await nOf('filter[n][in]=2.5e1,7')) === (await nOf('filter[n]=25')),
      'council 3 (6.1): 20.0 and 2e1 are the same operand of an integer field as 20');
    r = await get(`${B}/shelves?filter[n]=20.5`);
    ok(r.res.status === 400 && r.json.code === 'invalid_parameter' && r.json.parameter === 'filter[n]', 'and 20.5 gives invalid_parameter', r.body);
    const pg = await get(`${B}/shelves?filter[n][ge]=-1000&limit=1`);
    const nextOf = (v) => `${B}${pg.json.next.replace('=-1000&', `=${v}&`)}`;
    ok(/=-1000&/.test(pg.json.next) && (await get(nextOf('-1000.0'))).res.status === 200 && (await get(nextOf('-1e3'))).res.status === 200
      && (await get(nextOf('-999'))).res.status === 400, 'also for the cursor: equal operands keep it, another value does not (6.4)', pg.json.next);
    r = await get(`${B}/shelves`, { method: 'POST', headers: json, body: JSON.stringify({ at: '2016-12-31T23:59:60Z' }) });
    ok(r.res.status === 422 && r.json.errors?.some((e) => e.pointer === '/at' && e.code === 'format'), 'council 4 (3): an instant with a leap second in a body gives 422 with a format entry', r.body);
    r = await get(`${B}/shelves`, { method: 'POST', headers: json, body: JSON.stringify({ times: ['2016-12-31T23:59:59Z', '2016-12-31T23:59:60Z'] }) });
    ok(r.res.status === 422 && r.json.errors?.some((e) => e.pointer === '/times/1' && e.code === 'format'), 'and so does one in a list, at its element', r.body);
    r = await get(`${B}/books`, { method: 'POST', headers: json, body: JSON.stringify({ id: 'leap', title: 'x', created_at: '2016-12-31T23:59:60Z' }) });
    ok(r.res.status === 201, 'a field only the server sets is ignored whatever its value, a leap second included (5.1)', r.body);
    r = await get(`${B}/shelves`, { method: 'POST', headers: json, body: JSON.stringify({ rank: 5 }) });
    const rankNull = await get(`${B}/shelves`, { method: 'POST', headers: json, body: JSON.stringify({ rank: null }) });
    ok(r.res.status === 422 && r.json.errors?.some((e) => e.pointer === '/rank' && e.code === 'read_only') && rankNull.res.status === 201,
      'council 5 (5.1): a readOnly field not listed in x-mock-server-only is not server-only: another value in a POST gives read_only', r.body);
    r = await get(`${B}/books/b-1`, { method: 'PATCH', headers: patch, body: JSON.stringify({ created_at: '1999-01-01T00:00:00Z' }) });
    ok(r.res.status === 422 && r.json.errors?.[0]?.code === 'read_only' && /x-mock-server-only: "id"/.test(m7.stderrText()) && /x-mock-server-only: "nope"/.test(m7.stderrText()),
      'a server-only field cannot be set by a PATCH either, and id or an unknown field is not one (with a warning)', r.body);
    r = await get(`${B}/books:new?x=1`);
    ok(r.res.status === 400 && r.json.code === 'unsupported_parameter' && r.json.parameter === 'x', 'council 6 (11.1): a GET action without params answers any parameter with unsupported_parameter', r.body);
    r = await get(`${B}/books/u-7`, { method: 'PATCH', headers: { ...patch, 'if-none-match': '*' }, body: JSON.stringify({ title: 'Siete' }) });
    const again7 = await get(`${B}/books/u-7`, { method: 'PATCH', headers: { ...patch, 'if-none-match': '*' }, body: JSON.stringify({ title: 'Siete' }) });
    ok(r.res.status === 201 && again7.res.status === 412, 'council 7 (7.2): with upsert, If-None-Match: * creates a free id and gives 412 on a taken one', `${r.res.status} ${again7.res.status}`);
    ok(JSON.stringify(doc.singletons.settings.method_effects) === '{"PATCH":[]}' && !('method_effects' in doc.singletons.summary) && /Singleton settings: method_effects/.test(m7.stderrText()),
      'council 8 (4.3, 5.9): a singleton serves method_effects with PATCH only, and only where it supports PATCH', JSON.stringify(doc.singletons.settings));
    r = await get(`${B}/shelves`, { method: 'POST', headers: json, body: '{"labels":["ok","\\udc00"]}' });
    const named = await get(`${B}/shelves`, { method: 'POST', headers: json, body: '{"x\\ud800":1}' });
    ok(r.res.status === 422 && r.json.errors?.some((e) => e.pointer === '/labels/1' && e.code === 'format') && named.res.status === 422 && named.json.errors?.[0]?.pointer === '',
      'council 11 (3): an unpaired surrogate gives 422 with a format entry at the string that holds it', `${r.body} ${named.body}`);
    r = await get(`${B}/shelves`, { method: 'POST', headers: json, body: '{"labels":["\\ud800"],' });
    ok(r.res.status === 400 && r.json.code === 'bad_request', 'and a JSON syntax error wins with 400 bad_request (5.4)', r.body);
    const key = (k) => ({ ...json, 'idempotency-key': `"${k}"` });
    const t1 = await get(`${B}/books/2:touch`, { method: 'POST', headers: key('t1'), body: '{}' });
    const t2 = await get(`${B}/books/2:touch`, { method: 'POST', headers: key('t1'), body: '{}' });
    ok(t1.res.status === 200 && t1.res.headers.has('etag') && t2.res.headers.get('idempotent-replayed') === 'true' && t2.res.headers.get('etag') === t1.res.headers.get('etag'),
      'council 12 (7.1): a replay whose body is still the current representation keeps its ETag', `${t1.res.status} ${t2.res.headers.get('etag')}`);
    await get(`${B}/books/2`, { method: 'PATCH', headers: patch, body: JSON.stringify({ title: 'Cambiado' }) });
    const t3 = await get(`${B}/books/2:touch`, { method: 'POST', headers: key('t1'), body: '{}' });
    ok(t3.res.status === 200 && t3.res.headers.get('idempotent-replayed') === 'true' && !t3.res.headers.has('etag') && !t3.res.headers.has('content-location') && !('_etag' in t3.json),
      'after another write, its replay carries no ETag, Content-Location or _etag', `${[...t3.res.headers.keys()]} ${t3.body}`);
    const c1 = await get(`${B}/books`, { method: 'POST', headers: key('c1'), body: JSON.stringify({ id: 'rp', title: 'a' }) });
    await get(`${B}/books/rp`, { method: 'PATCH', headers: patch, body: JSON.stringify({ title: 'b' }) });
    const c2 = await get(`${B}/books`, { method: 'POST', headers: key('c1'), body: JSON.stringify({ id: 'rp', title: 'a' }) });
    ok(c1.res.status === 201 && c2.res.status === 201 && c2.res.headers.get('location') === '/books/rp' && !c2.res.headers.has('etag') && !('_etag' in c2.json),
      'and so does the replay of a creation whose item changed since', `${c2.res.status} ${c2.body}`);

    // Council decisions on draft 7 (round 3).
    ok(doc.collections.mixed.upload?.multipart === true && /mixed\.upload: creates items from JSON and its media_types admit application\/json/.test(m7.stderrText()),
      'council b7 r3 2 (5.1): a collection that creates from JSON and admits application/json in media_types is served with multipart, with a warning', JSON.stringify(doc.collections.mixed.upload));
    r = await get(`${B}/mixed`, { method: 'POST', headers: json, body: '{"title":"Uno"}' });
    const mpBody = '--b0\r\nContent-Disposition: form-data; name="file"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{"title":"x"}\r\n--b0--\r\n';
    const mpFile = await get(`${B}/mixed`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b0' }, body: mpBody });
    ok(r.res.status === 201 && r.json.title === 'Uno' && !r.json._content && mpFile.res.status === 201 && mpFile.json._content?.media_type === 'application/json',
      'and a POST with application/json is an item, while a JSON file goes as the file part of multipart (5.1)', `${r.body} ${mpFile.body}`);
    ok(doc.collections.blobs.schemas?.create === undefined && doc.collections.mixed.schemas.create,
      'council b7 r3 1 (5.1): create is served only where the discovery announces creation from JSON');
    r = await get(`${B}/runs`, { method: 'POST', headers: json, body: JSON.stringify({ local: '2016-12-31T23:59:60' }) });
    ok(r.res.status === 422 && r.json.errors?.some((e) => e.pointer === '/local' && e.code === 'format'), 'council b7 r3 3 (3): a localdatetime with a leap second in a body gives 422 format', r.body);
    r = await get(`${B}/runs`, { method: 'POST', headers: json, body: JSON.stringify({ local: '2016-12-31T23:59:59', stamped: '2016-12-31T23:59:60' }) });
    ok(r.res.status === 201 && !/:60/.test(r.body), 'council b7 r3 4 (3, 5.1): a leap second in a server-only field of a POST is ignored', r.body);
    const runsPage = await get(`${B}/runs?limit=100`);
    const runs = runsPage.json?.items ?? [];
    ok(runs.length && runs.every((x) => !/:60/.test(JSON.stringify(x))), 'and the mock never writes one', runsPage.body.slice(0, 300));
    const mk = { ...json, 'idempotency-key': '"min"', prefer: 'return=minimal' };
    const m1 = await get(`${B}/readers`, { method: 'POST', headers: mk, body: '{}' });
    const m2 = await get(`${B}/readers`, { method: 'POST', headers: mk, body: '{}' });
    ok(m1.res.status === 201 && m1.body === '' && m2.res.status === 201 && m2.res.headers.get('idempotent-replayed') === 'true' && m2.body === ''
      && m2.res.headers.get('location') === m1.res.headers.get('location') && !m2.res.headers.has('etag') && !m2.res.headers.has('content-location')
      && (await get(`${B}${m1.res.headers.get('location')}`)).res.status === 200,
      'council b7 r3 5 (7.3): a replay of a 201 without body carries no ETag, even if the item exists', `${m1.res.status} ${[...m2.res.headers]}`);
    const okN = async (q) => (await get(`${B}/shelves?limit=100&${q}`)).res.status;
    const okP = async (q) => (await get(`${B}/runs:probe?${q}`)).res.status;
    const good = ['2e1', '2E%2B1', '20.0', '-0'], badOps = ['%2B20', '.5', '020', '0x14', '2e', '1.', '00'];
    const goodSt = [...await Promise.all(good.map((v) => okN(`filter[n]=${v}`))), ...await Promise.all(good.map((v) => okP(`n=${v}&x=${v}&ns=1,${v}`)))];
    const badSt = [...await Promise.all(badOps.map((v) => okN(`filter[n]=${v}`))), ...await Promise.all(badOps.flatMap((v) => [okP(`n=${v}`), okP(`x=${v}`), okP(`ns=1,${v}`)]))];
    ok(goodSt.every((s) => s === 200) && badSt.every((s) => s === 400),
      'council b7 r3 7 (6.1, 11.1): integer and number operands, and GET action params, follow the RFC 8259 number grammar', `${goodSt} | ${badSt}`);
    const withTags = await get(`${B}/books`, { method: 'POST', headers: json, body: JSON.stringify({ id: 'q9', title: 'q', formats: ['pdf'] }) });
    const noTags = await get(`${B}/books`, { method: 'POST', headers: json, body: JSON.stringify({ id: 'q8', title: 'q', formats: [] }) });
    const idsOf = async (q) => (await get(`${B}/books?limit=100&filter[active]=false&filter[title]=q&${q}`)).json?.items?.map((x) => x.id).sort().join();
    ok(withTags.res.status === 201 && noTags.res.status === 201 && (await idsOf('filter[reviews][null]=true')) === 'q8,q9'
      && (await idsOf('filter[reviews.rating][null]=true')) === 'q8,q9' && (await idsOf('filter[reviews.rating][null]=false')) === '',
      'council b7 r3 9 (6.1): null with a quantifier tests the whole relation, never whether some element is null', `${await idsOf('filter[reviews.rating][null]=true')}`);
    r = await get(`${B}/shelves`, { method: 'POST', headers: json, body: '{"labels":[],"o":{"\ufdd0":1}}' });
    ok(r.res.status === 422 && r.json.errors?.some((e) => e.pointer === '' && e.code === 'format'), 'council b7 r3 10 (3): a noncharacter in a nested member name points to ""', r.body);

    // Council decisions on draft 7 (round 4).
    const asFile = await Promise.all(['anyfiles', 'appfiles'].map((c) => get(`${B}/${c}`, { method: 'POST', headers: json, body: '{"title":"x"}' })));
    const img = await get(`${B}/imgfiles`, { method: 'POST', headers: json, body: '{"title":"x"}' });
    ok(asFile.every((x) => x.res.status === 201 && x.json._content?.media_type === 'application/json') && img.res.status === 415 && doc.collections.anyfiles.upload?.media_types?.[0] === '*/*',
      'council b7 r4 1a (5.1): in an upload-only collection, application/* or */* admits a JSON body as a file; image/* gives 415', `${asFile.map((x) => x.body)} ${img.res.status}`);
    const ld = await get(`${B}/ldmixed`, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: '{"title":"x"}' });
    const ldItem = await get(`${B}/ldmixed`, { method: 'POST', headers: json, body: '{"title":"Uno"}' });
    ok(ld.res.status === 201 && ld.json._content?.media_type === 'application/ld+json' && ldItem.res.status === 201 && ldItem.json.title === 'Uno' && !ldItem.json._content,
      'council b7 r4 1b (5.1): a +json type is a file; only application/json creates an item', `${ld.body} ${ldItem.body}`);
    const pngPart = (head) => `--b1\r\n${head}\r\nContent-Type: image/png\r\n\r\nx\r\n--b1--\r\n`;
    const mpAny = await get(`${B}/anyfiles`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b1' }, body: pngPart('Content-Disposition: form-data; name="file"; filename="a.png"') });
    const mixedType = await get(`${B}/anyfiles`, { method: 'POST', headers: { 'content-type': 'multipart/mixed; boundary=b1' }, body: 'x' });
    ok(mpAny.res.status === 415 && mixedType.res.status === 201 && mixedType.json._content?.media_type === 'multipart/mixed',
      'council b7 r4 2 (5.1): an outer multipart/form-data without multipart gives 415 even under */*; another multipart type is a file', `${mpAny.res.status} ${mixedType.body}`);
    const noName = await get(`${B}/files`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b1' }, body: pngPart('Content-Disposition: form-data; name="file"') });
    ok(noName.res.status === 201 && noName.json._content?.media_type === 'image/png', 'council b7 r4 4b (5.1): the server reads a file part without filename as the file', noName.body);
    const twoNull = await Promise.all(['filter[books][null]=true&filter[books.id][null]=true', 'filter[books.id][null]=false&filter[books][null]=false', 'filter[books][null]=true&filter[books.id][null]=false']
      .map((q) => get(`${B}/shelves?${q}`)));
    ok(twoNull.every((x) => x.res.status === 400 && x.json.code === 'invalid_parameter' && /books/.test(x.json.parameter)),
      'council b7 r4 5a (6.1): two null filters on one to-many relationship, its own or through a path, give invalid_parameter', twoNull.map((x) => x.body).join(' '));
    const shelves = (await get(`${B}/shelves?limit=100`)).json.items;
    const target = shelves.find((x) => (x.books ?? []).length);
    const noneQ = (await get(`${B}/shelves?limit=100&filter[books.id]=${target?.books[0].id}&filter[books][null]=true`)).json?.items?.map((x) => x.id) ?? [];
    ok(target && !noneQ.includes(target.id) && noneQ.length === shelves.filter((x) => !(x.books ?? []).some((b) => b.id === target.books[0].id)).length,
      'council b7 r4 5b (6.1): null=true with other filters of the group keeps the items where no element matches all of them', `${target?.id} ${noneQ}`);
    const over = await Promise.all(['filter[n]=1e301', 'filter[n][in]=1,-1e99999999999999999999'].map((q) => get(`${B}/shelves?${q}`))
      .concat(['n=1e400', 'x=1e-301', 'x=-1e400', 'ns=1,1.5e300'].map((q) => get(`${B}/runs:probe?${q}`))));
    const inside = await Promise.all([get(`${B}/shelves?filter[n][ge]=1e300`), get(`${B}/runs:probe?x=1e-300&n=-1e300`)]);
    ok(over.every((x) => x.res.status === 400 && x.json.code === 'invalid_parameter' && /1e-300 to 1e300/.test(x.json.detail)) && inside.every((x) => x.res.status === 200)
      && inside[0].json.items.length === 0,
      'council b7 r4 6 (5.3, 6.1): a numeric operand over the limit gives invalid_parameter naming it; within it, it is compared as a number', `${over.map((x) => x.res.status)} ${inside.map((x) => x.res.status)}`);
    await stop(m7);
  }

  console.log('Usage errors');
  const bad = (args, re, name) => {
    const r = spawnSync(process.execPath, [MOCK, ...args], { encoding: 'utf8' });
    ok(r.status === 2 && re.test(r.stderr), name, r.stderr.trim());
  };
  bad([], /missing the discovery document/, 'no arguments');
  bad([AGENDA, '--fail-rate', '2'], /between 0 and 1/, '--fail-rate out of range');
  bad([AGENDA, '--latency', '300-100'], /--latency/, '--latency reversed');
  bad([join(tmp, 'no-existe.json')], /Cannot read/, 'missing file');
  const notDiscovery = join(tmp, 'otro.json');
  writeFileSync(notDiscovery, '{"openapi": "3.1.0"}');
  bad([notDiscovery], /is not a Restep discovery document/, 'a JSON file that is not discovery');
  for (const v of ['2.0', '1.01', '1.0-beta.1']) {
    const f = join(tmp, `v-${v}.json`);
    writeFileSync(f, JSON.stringify({ restep: v, collections: {} }));
    bad([f], /only understands Restep 1/, `"restep": "${v}" is not Restep 1 (1.1)`);
  }
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.stack}`);
} finally {
  // Wait for them to finish, so that an immediately following run finds the ports free.
  await Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => { c.on('exit', r); c.kill(); }))));
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${failed} failed · ${passed} passed`);
process.exit(failed ? 1 : 0);
