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
  ok(JSON.stringify(served) === JSON.stringify(discovery), 'sirve el mismo descubrimiento que la referencia');
  const page = await get('http://localhost:8831/books?limit=50&count=true');
  ok(page.json.items.length === 50 && page.json.total === 50, 'genera 50 elementos por colección por defecto');

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
  ok(!doc.profiles.includes('sync') && doc.extensions.length === 0 && !doc.collections.talks.actions && !doc.collections.speakers.sync,
    'quita del descubrimiento lo que no implementa (sync, actions)');
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
  await mock(AGENDA, 8834, '--fail-rate', '1', '--retry-after', '3', '--quiet');
  const down = await get('http://localhost:8834/talks');
  ok(down.res.status === 503 && down.res.headers.get('content-type') === 'application/problem+json' && down.json.code === 'unavailable'
    && down.res.headers.get('retry-after') === '3', '--fail-rate 1 da 503 unavailable en problem+json con Retry-After');
  const health = await get('http://localhost:8834/status');
  ok(health.res.status === 200, 'el estado del servicio no se cae con la API');
  await mock(AGENDA, 8835, '--fail-rate', '0.5', '--seed', '3', '--quiet');
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await fetch('http://localhost:8835/venues')).status);
  const fails = codes.filter((c) => c === 503).length;
  ok(fails > 5 && fails < 35 && codes.every((c) => c === 200 || c === 503), `--fail-rate 0.5 falla una parte (${fails} de 40)`);
  await mock(AGENDA, 8836, '--latency', '150-200', '--quiet');
  const t0 = Date.now();
  await fetch('http://localhost:8836/venues');
  ok(Date.now() - t0 >= 150, `--latency 150-200 retrasa la respuesta (${Date.now() - t0} ms)`);

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
