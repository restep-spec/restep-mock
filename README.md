# restep-mock

API Restep 1 falsa a partir de un documento de descubrimiento (§4.2). Sirve para desarrollar un
cliente, un agente o una interfaz antes de que exista el servidor, o para probarlos contra datos
abundantes, latencia y caídas. Un solo archivo, Node 18+, sin dependencias.

No es un servidor de cartón: se comporta como uno real del borrador 6 en los perfiles `core`,
`query`, `writes`, `cache` y `relations` y las extensiones `actions` e `inherit`, con
subcolecciones, y pasa `restep-check --writes`
sin fallos con el descubrimiento del servidor de referencia (ver «Pruebas»). Gran parte del código viene de `vendor/restep-server.mjs`,
generalizado para cualquier descubrimiento.

## Uso

```bash
npx restep-mock discovery.json                       # http://localhost:8090/
npx restep-mock https://api.example.com/ --port 9000  # el descubrimiento de una API que ya existe
npx restep-mock agenda.json --seed 7 --count 20         # datos repetibles
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
  así el cliente ve exactamente la API que espera. Acepta cualquier versión de Restep 1 que siga la
  gramática de §1.1 (`1.0`, `1.1`, `1.0-draft.5`…), pero declara siempre `"restep": "1.0-draft.6"`,
  porque es el texto que implementa (§1.2), y lo avisa si el documento decía otra. Otra versión
  mayor, o un `restep` mal formado, no arranca.
- **core.** Colecciones con `items` y `next`, elementos en `path/id` (cada segmento comparado tras
  descodificarlo: `/books/%37` es `/books/7`), `HEAD` donde se declara `GET` (sin `GET`, también
  `405`), `405` con `Allow` según `methods` e `item_methods`, `404 not_found`, el orden de errores de §5.4, parámetros reservados no admitidos
  que fallan con `unsupported_parameter` (también `$cualquiera`, también en escrituras), errores en
  problem+json con `title` y `detail` en inglés o en español según `Accept-Language` (§5.6), mapas de
  idioma (§3). Tipos de medio de §3: `415` sin `Content-Type`, con otro tipo o con un `charset` que
  no es UTF-8 (con `Accept-Patch` en un `PATCH`), y `400` a un cuerpo vacío. Quién elige el `id`
  (`id_from`, §5.1): `"server"` (un `POST` con `id` da `422` con `read_only` en `/id`), `"client"`
  (sin `id`, `required`) o `"either"`, con `409 conflict` y `taken` para un `id` que la colección
  tiene o ha tenido, y sin dar nunca un `id` usado. Campos de solo lectura (`readOnly` en el
  esquema `item`): con su valor actual se ignoran, con otro dan `read_only`. Una relación a un
  elemento que no existe da `unknown` en su `id`; con su valor actual se ignora sin buscarla.
  Singletons (§5.9): `GET`, `HEAD` y, si se declara, `PATCH`; `POST` y `DELETE` dan `405`; solo
  `fields` entre los reservados. El estado del servicio (§4.4), si se declara una ruta en `status`.
- **Retiradas (§5.5).** Lo que usa algo avisado en `deprecations` (de cualquier `kind`, en la raíz,
  en una colección o en un singleton) lleva `Deprecation` y un `Link` con `rel="deprecation"`, y
  `Sunset` si se retira una colección, un singleton o la versión. Pasado el `sunset`, aplica la
  retirada de `filter`, `operator`, `sort`, `include`, `count`, `max_limit`, `method` e
  `item_method` (deja de declararlos, y el mock se comporta como si nunca lo hubieran estado) y de
  una colección o un singleton enteros (`410 retired`); un aviso vencido de otro `kind` no lo
  sirve.
- **query.** Filtros con todos los operadores y tipos de §6.1 (decimales exactos, instantes con desfase,
  duraciones por longitud y `invalid_parameter` con años o meses, booleanos, texto por puntos de
  código, traducciones `campo.etiqueta` sin idioma de reserva, rutas `relacion.id` y `relacion.campo`),
  orden solo por las claves de `sort`, con ausentes al final (sin `sort` declarado, también `sort=id`
  da `unsupported_parameter`, aunque el orden por defecto sea por `id`; desde 0.4.1), `collations` (`"server"` y cualquier valor que no sea `"codepoint"`
  comparan sin mayúsculas ni acentos, §6.1), `fields`, `limit` dentro de `max_limit` (sin
  `max_limit` declarado, `limit` da `unsupported_parameter`), cursores firmados y ligados a
  colección, filtros y orden, `count` (`estimated` redondea a la decena y añade `total_estimated`;
  sin `count` declarado, `count` con cualquier valor da `unsupported_parameter`) y un tope de 500
  valores en `in` que da `invalid_parameter`.
- **writes.** `POST`, `PATCH` (Merge Patch, también con `application/json`) y `DELETE`, validación con
  `422 invalid` y una entrada por fallo, `Idempotency-Key` (repetición, `Idempotent-Replayed`,
  `idempotency_mismatch` también con otra query, clave mal formada o con parámetros con una entrada
  para la cabecera, y `"anonymous": false`, que rechaza con `400` una clave sin credenciales), ETag
  fuerte, `_etag` en toda respuesta cuyo cuerpo es un elemento (también con `fields`, `include` o
  en las escrituras) y en cada elemento de un listado que admite `PATCH` o `DELETE`, `If-Match` e
  `If-None-Match` (también en el `POST` a una colección), `404` a una escritura sobre un elemento
  borrado, y `Prefer: return=minimal` con la `ETag` del elemento.
- **cache.** `Cache-Control` en toda respuesta a `GET` o `HEAD`, errores incluidos, `ETag` y `304`,
  y `Cache-Groups` y `Cache-Group-Invalidation` (§8), estas dos solo si el descubrimiento anuncia
  `cache`.
- **inherit.** Valores heredados (§11.6) con `_inherited`, ciclos rechazados y fuentes reales. Si
  alguna colección declara `inherit`, el descubrimiento servido anuncia la extensión (y lo avisa si
  el documento no lo hacía, como en el borrador 5).
- **Subcolecciones (§4.2, §5.1).** Una colección con `parent` y una plantilla en `path`
  (`/authors/{author_id}/books`), a cualquier profundidad (`/authors/{author_id}/books/{book_id}/reviews`).
  Se comprueba lo que exige §4.2: `parent` declarado y simulado, variables con nombres distintos y
  un `path` que es el de su padre, `/`, su variable y algo más sin variables; lo que no encaja se
  omite con su aviso, y con ello lo que cuelga de ello. Cada elemento padre tiene sus propios
  elementos (3 por defecto, o `--count nombre=n` por padre), con `id` propios bajo ese padre
  (`/authors/1/books/1` y `/authors/2/books/1`). Una ruta bajo un padre que no existe da `404`; el
  `POST` crea bajo ese padre, con `Location` completa; `id_from`, `taken`, cursores y grupos de caché
  van por padre. Borrar un elemento borra sus subcolecciones enteras (y sus descendientes) y los
  enlaces que apuntaban a ellos; sus `id` no se vuelven a dar.
- **actions (§11.1).** Cada acción declarada con `on`, `safe` e `idempotent` (y `method`); la que se
  llama `changes`, la `GET` que no es segura o con `input`, y la que lleva un `on` o un `method`
  que el borrador 6 no define, no se sirven. Como el mock no conoce su lógica, **una acción
  simulada no cambia ningún dato**. Lo que sí hace:
  - `POST /coleccion/{id}:nombre` o `/coleccion:nombre` (también con `%3A`), según `on`; la que no
    está declarada, o se pide en el otro tipo de recurso, da `404`, como un elemento que no existe;
    otro método, `405` con `Allow`. Un parámetro reservado da `unsupported_parameter`.
  - El cuerpo: vacío, con o sin `Content-Type`, es `{}`; si no está vacío sigue §3 (`415`, `400`).
    Se valida contra su `input`, incrustado o enlazado (tipos, `required`, `enum`, `const`, rangos,
    longitudes, `pattern`, `format` de fechas, `additionalProperties`, `items`, `anyOf`, en objetos
    anidados): `422 invalid` con una entrada por fallo. Sin `input` legible, acepta cualquier objeto.
  - Una acción con `"idempotent": false` sigue §7.1 con `Idempotency-Key` (repetición, `422
    idempotency_mismatch`, `400` con una clave mal formada o sin credenciales con `"anonymous": false`);
    una con `"idempotent": true` no rechaza nunca la clave: la ignora y no guarda nada.
  - `If-Match` e `If-None-Match` contra el elemento (o contra la colección, en una de colección).
  - Responde la representación del recurso afectado (`200`): el elemento, con su `_etag` y su `ETag`,
    o, en una acción `GET` de colección, su primera página. Una de colección con `POST` responde `204`
    sin cuerpo, y una de elemento con `Prefer: return=minimal`, `204` con la `ETag`. Nunca `201`
    ni `409`.
  - Un aviso `action` en `deprecations` da `Deprecation` y `Sunset` y, vencido, `410 retired`.
- **relations (§9).** `include` con rutas hasta `include_depth` (1 si falta), solo en relaciones con
  `"include": true`; `fields` con rutas con punto, que exigen el `include` y un campo que exista en el
  incluido; relaciones a muchos como listas, sin paginar; relaciones a varias colecciones con `type`,
  cuyo `include` rellena el elemento de esa colección (y no deja seguir más hondo); un relacionado
  que no existe se queda en su `{id}`. Los enlaces a elementos de una subcolección llevan `href`, que
  se conserva al incluirlos, y al escribir se exige: un `href` que no es la ruta de un elemento de
  esa colección, o cuyo último segmento no es el `id`, da `422` en `/rel/href`; uno que no existe,
  `unknown` en `/rel/id`; de cada enlace solo se guardan `id`, `type` y `href`. Una relación a
  muchos cuyo `path` es la plantilla de una subcolección de la propia colección **lleva a ella**: no
  se incrusta en la representación (para eso está la subcolección), con `include` trae sus
  elementos bajo ese padre, y no se escribe (con su valor actual se ignora; con otro, `read_only`).
  Una relación se sustituye entera al escribir y se valida que su destino exista; con su valor
  actual se ignora. En `filter` y `sort` no sirve (y lo avisa) una ruta que pasa por una relación a
  muchos ni una que acaba en el `id` de un elemento de una subcolección (§6.1).
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
4. **Relaciones** a elementos que existen: genera antes los padres y las colecciones de destino, y en
   una relación a la propia colección solo enlaza con elementos anteriores, así que no hay ciclos. Un
   enlace a un elemento de una subcolección elige padre y elemento, y lleva su `href`; esos enlaces se
   rellenan al final, porque la subcolección puede colgar de la propia colección (un libro que
   destaca una de sus reseñas). Si la subcolección cuelga del propio elemento o de uno de sus padres,
   el enlace se queda bajo ese mismo padre: el destacado de un libro es una reseña de ese libro. En una herencia, el
   campo propio suele ir a `null` para que herede, y el valor por defecto (si `"default": true`) se
   genera una vez por colección y campo.

Los `id` son `"1"`, `"2"`…, bajo cada padre en una subcolección; los creados siguen la numeración.
`--dump` da una lista por colección y, en una subcolección, una por cada ruta de colección.

## Lo que no simula

Lo quita del descubrimiento que sirve, y lo avisa por la salida de errores, para no anunciar nada
que no cumple:

- El perfil `sync` y las extensiones `batch`, `filter-expr`, `query-method` y `oauth`; los
  miembros `sync`, `batch` y `events`.
- Las subcolecciones que no cumplen §4.2 (arriba), y las acciones que no cumplen §11.1.
- Los singletons con plantilla o `parent` (§5.9 los reserva) y los campos de relación o de mapa de
  idioma de un singleton.
- Un `id_from` con un valor que el borrador 6 no define.
- Los avisos de `deprecations` con un `kind` fuera de su sitio, y los vencidos de `field`, `value`,
  `relation`, `action`, `version`, `extension` y `reason`.

Otros límites:

- La validación con esquema cubre tipos, `required`, `enum`, `minimum`, `maximum`, `minLength`,
  `maxLength` y `pattern` de los campos de primer nivel; no `allOf`, `$ref`, objetos anidados ni
  `format` fuera de fechas y duraciones.
- Acepta cualquier etiqueta bien formada en un mapa de idioma (nunca da el código `unknown` de §3).
- La lógica de las acciones: no cambian datos, no crean nada (`201`) ni dan `409` por el estado del
  elemento, y no pone `_actions` en las representaciones (es un PUEDE).
- No hay esquema de salida de una acción en Restep 1, así que no genera otra respuesta que el recurso
  afectado.
- Una relación a una colección que no está en el descubrimiento (o que se omite) queda a `null`.
- Los textos del descubrimiento van en el idioma en que vinieron; solo los errores cambian con
  `Accept-Language` (inglés y español).
- La idempotencia y las escrituras viven en memoria; el cursor no está ligado al principal.
- No hay credenciales: ninguna respuesta depende de ellas (así que no hace falta `private`, §5.1),
  no hay `401` ni `403`, ni la comprobación de `Origin` de §5.8, y todas las claves de idempotencia
  son del principal anónimo salvo que la petición traiga `Authorization`.
- En un `POST`, un campo de solo lectura distinto de `id` solo se ignora si vale `null`: el mock no
  calcula «el valor que recibiría el elemento» (§5.1).
- No pone `service-doc` (§4.2): no conoce la documentación de la API que simula (restep-check lo
  avisa).
- Nunca da `429` ni `503` a una petición con efecto: los fallos simulados llegan antes de hacer nada.

## Pruebas

```bash
node tools/restep-mock/test.mjs     # desde projects/restep; usa los puertos 8830-8839
```

Arranca el servidor de referencia, guarda su descubrimiento, levanta el mock con él y pasa
`vendor/restep-check.mjs --writes`; hace lo mismo con `test/agenda.json`, un descubrimiento
propio con fechas, instantes, duraciones, booleanos, `relations` con `include`, una relación a
muchos, un esquema enlazado, una acción y lo que el mock no implementa (`sync`); y con
`test/biblioteca.json`, inventado, con subcolecciones de dos niveles, acciones de elemento y de
colección (`POST` con `input`, `GET`, idempotentes o no, y las que el texto prohíbe), una relación a
elementos de una subcolección, otra que lleva a una subcolección y otra polimórfica. Además prueba la
semilla, `--fail-rate`, `--latency`, `--count` por colección, los errores de uso y lo del borrador
6: el singleton `shop`, `Deprecation` al ordenar por `year`, tipos de medio, `id_from`, `taken`,
colaciones, la query en `Idempotency-Key`, la versión declarada, `inherit` anunciado, retiradas
vencidas, `limit` y `count` sin declarar y `"anonymous": false`; y, en la biblioteca, rutas bajo
padres que existen o no, `POST` y `DELETE` en cascada, enlaces con `href` (sin él, con otro `id`,
a algo que no existe), `include` y `fields` con punto a través de subcolecciones y de una relación
polimórfica, y cada regla de las acciones de arriba. Con un descubrimiento propio prueba además que
los enlaces a una subcolección no cambian de padre, que `include` los rellena y que una colección sin
`GET` da `405` también a `HEAD`.

Resultado actual (restep-check 0.9.1):

```
restep-check contra el mock de la referencia:  0 failed · 1 warning · 531 passed · 50 skipped
restep-check contra el mock de la agenda:      0 failed · 1 warning · 283 passed · 33 skipped
restep-check contra el mock de la biblioteca:  0 failed · 1 warning · 292 passed · 46 skipped
0 fallos · 110 correctas
```

El aviso es `discovery.service-doc` (arriba). Los `skip` son de restep-check, no del mock:
lo que necesita credenciales o CORS, colecciones sin campos de fecha, sin `id_from` o sin campos
`readOnly`, y similares.

## Dudas sobre la spec

1. **`path` de una colección y la raíz de la API.** El esquema del descubrimiento dice que `path` es
   «relativo a la raíz de la API, empezando por /», pero §3 exige que los enlaces de los cuerpos
   (`next`, `href`) y §4.3 los enlaces de `schemas` sean rutas absolutas que incluyen la ruta de la
   raíz. Con una raíz en `/api/`, no queda claro si `books` se declara como `/books` o `/api/books`.
   El mock sirve siempre en `/` y no le afecta, pero un cliente sí necesita saberlo.
2. **Filtros por una relación a muchos.** Resuelto en el borrador 6: una ruta que pasa por una
   relación a muchos no se puede declarar en `filter` ni en `sort` (§6.1).
3. **Cuánto puede desviarse `count: "estimated"`.** §6.5 no pone ningún límite; el mock redondea a la
   decena. Una cota orientativa (o decir que no la hay) ayudaría a quien escribe pruebas.
4. **Estado del servicio y `503` de la API.** §4.4 dice que `status` da `503` cuando la API no puede
   atender, pero no si un `503` suelto de un recurso (un fallo transitorio) debe reflejarse ahí. El
   mock deja `status` en `200` durante los fallos simulados.
5. **Tipos de los campos que no se filtran.** El descubrimiento solo declara tipos en `filter` (§4.2)
   y la forma completa va en `schemas`, que es opcional. Sin esquemas, un generador o un cliente
   tipado no tiene forma de saber qué campos tiene un elemento ni de qué tipo son los que no se
   filtran ni se ordenan; el mock los adivina por el nombre.
6. **Qué versión declara un mock (§1.1, §1.2).** Un servidor implementa el texto de la versión que
   declara. El mock sirve el descubrimiento de otra API, que puede declarar `1.0` o un borrador
   anterior; para no mentir declara siempre `1.0-draft.6`, aunque eso cambie el documento que el
   cliente esperaba.
7. **Retiradas vencidas que siguen en `deprecations`.** §5.5 dice cómo responde lo retirado, pero no
   si el aviso sigue en el descubrimiento después del `sunset`. El mock lo deja (con lo retirado ya
   sin declarar), para que se vea por qué falta.
8. **«El valor que recibiría el elemento» (§5.1).** En un `POST`, un campo de solo lectura se ignora
   si trae ese valor, pero para un campo que pone el servidor (`created_at`) el cliente no puede
   saberlo. El mock solo ignora `null`.
9. **La relación que lleva a una subcolección (§9).** «The relationship that leads to one MAY carry
   the same template in its path»: no dice si esa relación va incrustada en la representación del
   padre. Si va, es una lista que crece sin límite, justo lo que §9 dice que debería ser una
   subcolección; y un `POST` que copia un elemento leído llevaría la lista de otro padre. El mock no
   la incrusta, la rellena con `include` y la trata como de solo lectura. Tampoco dice si una
   relación a una subcolección **sin** `path` también «lleva a ella»: el mock la trata como una
   relación cualquiera a elementos sueltos, con `href`.
10. **Qué responde una acción simulada (§11.1).** El texto deja `200` (el recurso afectado), `201` y
    `204`, pero no qué es «el recurso afectado» de una acción de colección ni si una acción `GET`
    puede responder otra cosa (un cuerpo para un `POST`, por ejemplo); y Restep 1 no tiene esquema
    de salida para una acción. El mock responde el elemento, la primera página de la colección o
    `204`.
11. **Clave mal formada en una acción idempotente (§7.1, §11.1).** «NO DEBE rechazar una petición
    porque lleve una `Idempotency-Key` bien formada» no dice qué hacer con una mal formada. El mock
    la ignora, como cualquier clave en una acción idempotente.
12. **`include` a través de una relación polimórfica (§9).** `include=featured.books` cuando
    `featured` va a dos colecciones: ¿vale si el `type` de cada enlace tiene `books`? El mock da
    `unsupported_parameter`.
13. **Más de un nivel de subcolecciones (§4.2).** El texto lo admite
    (`/authors/{author_id}/books/{book_id}/reviews`), pero no dice si una ruta con más segmentos
    literales tras la variable (`/authors/{author_id}/x/books`) es válida. El mock la admite si no
    hay más variables.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-mock>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
