# restep-mock

API Restep 1 falsa a partir de un documento de descubrimiento (§4.2). Sirve para desarrollar un
cliente, un agente o una interfaz antes de que exista el servidor, o para probarlos contra datos
abundantes, latencia y caídas. Un solo archivo, Node 18+, sin dependencias.

No es un servidor de cartón: se comporta como uno real de los perfiles `core`, `query`, `writes` y
`relations`, y pasa `restep-check --writes` sin fallos con el descubrimiento del servidor de
referencia (ver «Pruebas»). Gran parte del código viene de `vendor/restep-server.mjs`,
generalizado para cualquier descubrimiento.

## Uso

```bash
npx restep-mock discovery.json                       # http://localhost:8090/
npx restep-mock https://api.example.com/ --port 9000  # el descubrimiento de una API que ya existe
node tools/restep-mock/restep-mock.mjs tools/restep-mock/test/agenda.json --seed 7 --count 20
```

| Opción | Qué hace |
|---|---|
| `--port <n>` | Puerto (por defecto 8090; `0` elige uno libre) |
| `--host <host>` | Interfaz en la que escucha (por defecto, todas) |
| `--seed <n>` | Semilla de los datos, de la firma de los cursores y de los fallos (por defecto 1) |
| `--count <n>` | Elementos por colección (por defecto 50) |
| `--count <col>=<n>` | Elementos de una colección concreta (repetible) |
| `--latency <ms\|a-b>` | Retraso de cada respuesta: fijo (`120`) o aleatorio en un rango (`0-300`) |
| `--fail-rate <0..1>` | Fracción de peticiones que responden `503 unavailable` en problem+json, con `Retry-After` |
| `--retry-after <s>` | Segundos de `Retry-After` en esos `503` (por defecto 1) |
| `--dump` | Escribe los datos generados en JSON y termina, sin levantar el servidor |
| `--quiet` | Sin avisos por la salida de errores |

Si se le da una URL, sigue un `Link rel="service-desc"` cuando la raíz no es el descubrimiento, y
lee los esquemas enlazados en `schemas` (con un archivo, los busca junto a él: `/schemas/x.json` es
`<carpeta del archivo>/schemas/x.json`). Los esquemas enlazados con ruta absoluta se sirven en esa
misma ruta.

Las escrituras viven en memoria y se pierden al parar. Código de salida 2 si no puede arrancar (opción
mal escrita, archivo que no existe, JSON que no es un descubrimiento, puerto ocupado).

## Qué simula

- **Descubrimiento.** Sirve el documento que recibe, sin tocar, salvo lo que no implementa (abajo):
  así el cliente ve exactamente la API que espera.
- **core.** Colecciones con `items` y `next`, elementos en `path/id`, `HEAD`, `405` con `Allow` según
  `methods` e `item_methods`, `404 not_found`, el orden de errores de §5.4, parámetros reservados no
  admitidos que fallan con `unsupported_parameter` (también `$cualquiera`, también en escrituras),
  errores en problem+json con `title` y `detail` en inglés o en español según `Accept-Language` (§5.6),
  mapas de idioma (§3) y valores heredados (§5.7) con `_inherited`, ciclos rechazados y fuentes reales.
  El estado del servicio (§4.4), si se declara una ruta en `status`.
- **query.** Filtros con todos los operadores y tipos de §6.1 (decimales exactos, instantes con desfase,
  duraciones por longitud y `invalid_parameter` con años o meses, booleanos, texto por puntos de
  código, traducciones `campo.etiqueta` sin idioma de reserva, rutas `relacion.id` y `relacion.campo`),
  orden con ausentes al final, `fields`, `limit` dentro de `max_limit`, cursores firmados y ligados a
  colección, filtros y orden, y `count` (`estimated` redondea a la decena y añade `total_estimated`).
- **writes.** `POST`, `PATCH` (Merge Patch, también con `application/json`) y `DELETE`, validación con
  `422 invalid` y una entrada por fallo, `Idempotency-Key` (repetición, `Idempotent-Replayed`,
  `idempotency_mismatch`, clave mal formada), ETag fuerte, `_etag` con `fields` o `include`,
  `If-Match` e `If-None-Match`, `Prefer: return=minimal`, `Cache-Control` en todo, y `Cache-Groups` y
  `Cache-Group-Invalidation` (§7.3).
- **relations.** `include` con rutas hasta `include_depth`, solo en relaciones con `"include": true`,
  `fields` con rutas con punto (que exigen el `include`), relaciones a muchos como listas de `{id}` y
  relaciones a varias colecciones con `type`. Una relación se sustituye entera al escribir y se valida
  que su destino exista; borrar un elemento quita los enlaces que apuntaban a él.
- **Fallos y latencia.** `--fail-rate` responde `503 unavailable` antes de hacer nada (una escritura
  que falla así no tiene efecto ni gasta su `Idempotency-Key`). El recurso de `status` no se cae, para
  que un cliente pueda distinguir una caída transitoria de la API. Latencia y fallos son deterministas
  por semilla en el orden de llegada de las peticiones.

## Cómo genera los datos

Cada valor sale de un generador propio para (semilla, colección, elemento, campo): misma semilla y
mismo descubrimiento dan los mismos datos, y añadir un campo no cambia los demás.

1. **Campos y tipos.** Primero el esquema `item` (o `create`) de `schemas`, incrustado o enlazado:
   `anyOf`/`type` con `null`, `format` (`date-time`, `date`, `duration`), `pattern` de decimal,
   `enum`, objetos con `id` (relaciones) y objetos de cadenas (mapas de idioma). Manda el tipo que
   declara `filter` para ese campo, y `language_maps`, `relations` e `inherit` dicen qué campos son
   mapas, relaciones y herencias. Sin esquema, los campos son los que nombran `filter`, `sort`,
   `language_maps`, `relations` e `inherit`, y el tipo que no se declare sale del nombre
   (`*_at` → `datetime`, `price` → `decimal`, `is_*` → `boolean`, `year` → `integer`…).
2. **Valores plausibles** según tipo y nombre: `email` (`ines.arriaga3@example.com`), nombres de
   persona en colecciones de personas (`speakers`, `users`, `authors`…), de sala en las de lugares,
   `title`, `description`, `url`, `phone`, `city`, `country`, `currency`, `sku`, `isbn`, `status`;
   `price` y `amount` como decimales en cadena, `tax`/`vat` entre 4, 10 y 21, `rating` de 1 a 5,
   `year`, `stock`; fechas de nacimiento razonables, `updated_at` posterior a `created_at`, citas en
   horario y en cuartos de hora; duraciones sin años ni meses. Respeta `minimum`, `maximum`,
   `minLength`, `maxLength` y `enum` del esquema.
3. **Huecos a propósito**: un 10 % de los campos opcionales va a `null` (para que el operador `null`
   y el orden de ausentes tengan algo que probar), los mapas de idioma tienen las etiquetas que el
   descubrimiento usa en `filter` y `sort` más `en` y `es`, con traducciones que faltan, y alguno vacío.
4. **Relaciones** a elementos que existen: genera antes las colecciones de destino, y en una relación a
   la propia colección solo enlaza con elementos anteriores, así que no hay ciclos. En una herencia, el
   campo propio suele ir a `null` para que herede, y el valor por defecto (si `"default": true`) se
   genera una vez por colección y campo.

Los `id` son `"1"`, `"2"`…; los creados siguen la numeración.

## Lo que no simula

Lo quita del descubrimiento que sirve, y lo avisa por la salida de errores, para no anunciar nada
que no cumple:

- El perfil `sync` y todas las extensiones (`actions`, `batch`, `filter-expr`, `query-method`,
  `oauth`); los miembros `sync`, `actions`, `batch` y `events`.
- Las subcolecciones (`path` con plantilla, como `/books/{id}/reviews`): se omiten.
- `deprecations` (§5.5): no da `Deprecation`, `Sunset` ni `410 retired`.

Otros límites:

- La validación con esquema cubre tipos, `required`, `enum`, `minimum`, `maximum`, `minLength`,
  `maxLength` y `pattern` de los campos de primer nivel; no `allOf`, `$ref`, objetos anidados ni
  `format` fuera de fechas y duraciones.
- Acepta cualquier etiqueta bien formada en un mapa de idioma (nunca da el código `unknown` de §3).
- No filtra por rutas que atraviesan una relación a muchos (`speakers.id`): ver «Dudas».
- Una relación a una colección que no está en el descubrimiento (o que se omite) queda a `null`.
- Los textos del descubrimiento van en el idioma en que vinieron; solo los errores cambian con
  `Accept-Language` (inglés y español).
- La idempotencia y las escrituras viven en memoria; el cursor no está ligado al principal.

## Pruebas

```bash
node tools/restep-mock/test.mjs     # desde projects/restep; usa los puertos 8830-8836
```

Arranca el servidor de referencia, guarda su descubrimiento, levanta el mock con él y pasa
`vendor/restep-check.mjs --writes`; hace lo mismo con `test/agenda.json`, un descubrimiento
propio con fechas, instantes, duraciones, booleanos, `relations` con `include`, una relación a
muchos, un esquema enlazado y lo que el mock no implementa (`sync`, `actions`). Además prueba la
semilla, `--fail-rate`, `--latency`, `--count` por colección y los errores de uso.

Resultado actual:

```
restep-check contra el mock de la referencia: 0 failed · 0 warnings · 252 passed · 4 skipped
restep-check contra el mock de la agenda:     0 failed · 0 warnings · 217 passed · 5 skipped
0 fallos · 31 correctas
```

Los `skip` son de restep-check, no del mock: colecciones sin campos `decimal` o de fecha, sin una
relación a sí mismas en `from`, o con menos de dos filtros `eq`.

## Dudas sobre la spec

1. **`path` de una colección y la raíz de la API.** El esquema del descubrimiento dice que `path` es
   «relativo a la raíz de la API, empezando por /», pero §3 exige que los enlaces de los cuerpos
   (`next`, `href`) y §4.3 los enlaces de `schemas` sean rutas absolutas que incluyen la ruta de la
   raíz. Con una raíz en `/api/`, no queda claro si `books` se declara como `/books` o `/api/books`.
   El mock sirve siempre en `/` y no le afecta, pero un cliente sí necesita saberlo.
2. **Filtros por una relación a muchos.** §6.1 permite declarar `author.id`, pero no dice qué
   significa `filter[speakers.id]=3` cuando `speakers` es una lista: ¿alguno, todos? El mock no lo
   admite.
3. **Cuánto puede desviarse `count: "estimated"`.** §6.5 no pone ningún límite; el mock redondea a la
   decena. Una cota orientativa (o decir que no la hay) ayudaría a quien escribe pruebas.
4. **Estado del servicio y `503` de la API.** §4.4 dice que `status` da `503` cuando la API no puede
   atender, pero no si un `503` suelto de un recurso (un fallo transitorio) debe reflejarse ahí. El
   mock deja `status` en `200` durante los fallos simulados.
5. **Tipos de los campos que no se filtran.** El descubrimiento solo declara tipos en `filter` (§4.2)
   y la forma completa va en `schemas`, que es opcional. Sin esquemas, un generador o un cliente
   tipado no tiene forma de saber qué campos tiene un elemento ni de qué tipo son los que no se
   filtran ni se ordenan; el mock los adivina por el nombre.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-mock>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
