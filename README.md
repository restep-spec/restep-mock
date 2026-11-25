# restep-mock

A fake Restep 1 API built from a discovery document (§4.2). Use it to develop a client, an agent
or a UI before the server exists, or to test them against plenty of data, latency and outages. A
single file, Node 18+, no dependencies.

It is not a cardboard server: it behaves like a real draft 7 server in the `core`, `query`,
`writes`, `cache` and `relations` profiles and the `actions` and `inherit` extensions, with
subcollections, and passes `restep-check --writes`
with no failures using the reference server's discovery document (see "Tests"). Much of the code comes from `vendor/restep-server.mjs`,
generalized for any discovery document.

## Usage

```bash
npx restep-mock discovery.json                       # http://localhost:8090/
npx restep-mock https://api.example.com/ --port 9000  # the discovery document of an existing API
npx restep-mock agenda.json --seed 7 --count 20         # repeatable data
```

| Option | What it does |
|---|---|
| `--port <n>` | Port (default 8090; `0` picks a free one) |
| `--host <host>` | Interface to listen on (default: all) |
| `--seed <n>` | Seed for the data, the cursor signatures and the failures (default 1) |
| `--count <n>` | Items per collection (default 50) |
| `--count <col>=<n>` | Items for a specific collection (repeatable) |
| `--latency <ms\|a-b>` | Delay for each response: fixed (`120`) or random within a range (`0-300`) |
| `--fail-rate <0..1>` | Fraction of requests that respond `503 unavailable` in problem+json, with `Retry-After` |
| `--retry-after <s>` | Seconds of `Retry-After` in those `503`s (default 1) |
| `--dump` | Writes the generated data as JSON and exits, without starting the server |
| `--quiet` | No warnings on standard error |

Given a URL, it follows a `Link rel="service-desc"` when the root is not the discovery document,
and reads the schemas linked from `schemas` (with a file, it looks for them next to it:
`/schemas/x.json` is `<file's folder>/schemas/x.json`). Schemas linked with an absolute path are
served at that same path.

Writes live in memory and are lost on stop. Exit code 2 if it cannot start (misspelled option,
missing file, JSON that is not a discovery document, port in use).

## What it simulates

- **Discovery.** It serves the document it receives untouched, except for what it does not
  implement (below): that way the client sees exactly the API it expects. It accepts any Restep 1
  version that follows the grammar of §1.1 (`1.0`, `1.1`, `1.0-draft.5`…), but always declares
  `"restep": "1.0-draft.7"`, because that is the text it implements (§1.2), and warns if the
  document said otherwise. Another major version, or a malformed `restep`, does not start.
- **core.** Collections with `items` and `next`, items at `path/id` (each segment compared after
  decoding: `/books/%37` is `/books/7`), `HEAD` wherever `GET` is declared (without `GET`, also
  `405`), `405` with `Allow` according to `methods` and `item_methods`, `404 not_found`, the error order of §5.4, unsupported reserved parameters
  that fail with `unsupported_parameter` (also `$anything`, also on writes), problem+json errors
  with `title` and `detail` in English or Spanish depending on `Accept-Language` (§5.6), language
  maps (§3). Media types per §3: `415` without `Content-Type`, with another type or with a
  `charset` other than UTF-8 (with `Accept-Patch` on a `PATCH`), and `400` for an empty body. Who
  picks the `id` (`id_from`, §5.1): `"server"` (a `POST` with `id` gives `422` with `read_only` at
  `/id`), `"client"` (without `id`, `required`) or `"either"`, with `409 conflict` and `taken` for
  an `id` the collection has or has had, and never handing out a used `id`. Read-only fields
  (`readOnly` in the `item` schema): ignored with their current value, `read_only` with another.
  A body with an unpaired surrogate or a noncharacter gives `422 invalid` with a `format` entry
  whose `pointer` is the string that holds it, or `""` when that string is a member name, after the
  preconditions; a body that is not JSON gives `400 bad_request` first (§3, §5.4).
  A relation to an item that does not exist gives `unknown` at its `id`; with its current value it
  is ignored without looking it up. Singletons (§5.9): `GET`, `HEAD` and, if declared, `PATCH`;
  `POST` and `DELETE` give `405`; only `fields` among the reserved parameters. The service status
  (§4.4), if a path is declared in `status`.
- **Retirements (§5.5).** Only a notice that retires a resource whole puts headers on its
  responses: `version` (every response), `collection` and `singleton` (that resource and its items)
  and `action` (every response to it), with `Deprecation` set to the notice's `announced` instant,
  a `Link` with `rel="deprecation"` and, once there is a date, `Sunset`. A notice that retires only
  part of a resource (`field`, `filter`, `sort`…), a `profile` or an `extension` is announced in
  `deprecations` only. Once the `sunset` has passed, it applies the retirement of `filter`,
  `operator`, `sort`, `include`, `count`, `max_limit`, `method` and `item_method` (it stops
  declaring them, and the mock behaves as if they had never been declared) and of a whole
  collection or singleton (`410 retired`); every expired notice stays in `deprecations`, also one
  whose retirement it does not simulate (with a warning).
- **query.** Filters with every operator and type of §6.1 (exact decimals, instants with offset,
  durations by length and `invalid_parameter` with years or months, booleans, text by code
  points, `field.tag` translations with no fallback language, `relation.id` and `relation.field`
  paths), sorting only by the keys in `sort`, with missing values last (with no `sort` declared,
  `sort=id` also gives `unsupported_parameter`, even though the default order is by `id`; since
  0.4.1), `collations` (`"server"` and any value other than `"codepoint"` compare ignoring case
  and accents, §6.1), `fields`, `limit` within `max_limit` (with no `max_limit` declared, `limit`
  gives `unsupported_parameter`), cursors signed and bound to the collection, filters and order,
  `count` (`estimated` rounds to the nearest ten and adds `total_estimated`; with no `count`
  declared, `count` with any value gives `unsupported_parameter`) and a cap of 500 values in `in`
  that gives `invalid_parameter`.
- **writes.** `POST`, `PATCH` (Merge Patch, also with `application/json`) and `DELETE`,
  validation with `422 invalid` and one entry per failure, `Idempotency-Key` (replay,
  `Idempotent-Replayed`, `idempotency_mismatch` also with a different query, a malformed key or
  one with parameters with an entry for the header, and `"anonymous": false`, which rejects a key
  without credentials with `400`), strong ETag, `_etag` in every response whose body is an item
  (also with `fields`, `include` or on writes) and in each item of a listing that allows `PATCH`
  or `DELETE`, `If-Match` and `If-None-Match` (also on the `POST` to a collection), `404` for a
  write on a deleted item, and `Prefer: return=minimal` with the item's `ETag`. A replay whose
  stored body is no longer the item's current representation (the item changed since) carries no
  `ETag`, `Content-Location` or `_etag` (§7.1), and a replay of a `201` without body
  (`return=minimal`) carries no `ETag` even if the item exists (§7.3). An instant or a local
  date-time with a leap second (`:60`) in a body gives `422 invalid` with a `format` entry, at the
  element in a list, except in a server-only field of a `POST`, which is ignored (§3).
- **cache.** `Cache-Control` on every response to `GET` or `HEAD`, errors included, `ETag` and
  `304`, and `Cache-Groups` and `Cache-Group-Invalidation` (§8), these two only if the discovery
  document announces `cache`.
- **inherit.** Inherited values (§11.6) with `_inherited`, cycles rejected and real sources. If
  any collection declares `inherit`, the served discovery document announces the extension (and
  warns if the document did not, as in draft 5).
- **Subcollections (§4.2, §5.1).** A collection with `parent` and a template in `path`
  (`/authors/{author_id}/books`), at any depth (`/authors/{author_id}/books/{book_id}/reviews`).
  It checks what §4.2 requires: `parent` declared and simulated, variables with distinct names and
  a `path` that is its parent's, `/`, its variable and something more without variables; whatever
  does not fit is omitted with a warning, along with whatever hangs from it. Each parent item has
  its own items (3 by default, or `--count name=n` per parent), with their own `id`s under that
  parent (`/authors/1/books/1` and `/authors/2/books/1`). A path under a parent that does not
  exist gives `404`; `POST` creates under that parent, with a full `Location`; `id_from`, `taken`,
  cursors and cache groups are per parent. Deleting an item deletes its whole subcollections (and
  their descendants) and the links that pointed to them; their `id`s are not handed out again.
- **actions (§11.1).** Each declared action with `on`, `safe` and `idempotent` (and `method`);
  the one named `changes`, a `GET` one that is not safe or has `input`, and one with an `on` or
  `method` that draft 7 does not define are not served. Since the mock does not know their logic,
  **a simulated action changes no data**. What it does do:
  - `POST /collection/{id}:name` or `/collection:name` (also with `%3A`), depending on `on`; one
    that is not declared, or is requested on the other kind of resource, gives `404`, like an item
    that does not exist; another method, `405` with `Allow`. A reserved parameter gives
    `unsupported_parameter`.
  - The body: empty, with or without `Content-Type`, is `{}`; if not empty it follows §3 (`415`,
    `400`; without `params`, any query parameter gives `unsupported_parameter`, as if it declared
  `"params": {}`). It is validated against its `input`, embedded or linked (types, `required`, `enum`,
    `const`, ranges, lengths, `pattern`, date `format`, `additionalProperties`, `items`, `anyOf`,
    in nested objects): `422 invalid` with one entry per failure. Without a readable `input`, it
    accepts any object.
  - An action with `"idempotent": false` follows §7.1 with `Idempotency-Key` (replay, `422
    idempotency_mismatch`, `400` with a malformed key or without credentials with `"anonymous": false`);
    one with `"idempotent": true` never rejects the key: it ignores it and stores nothing.
  - `If-Match` and `If-None-Match` against the item (or against the collection, for a collection
    action).
  - It responds with the representation of the affected resource (`200`): the item, with its
    `_etag` and its `ETag`, or, for a collection `GET` action, its first page. A collection action
    with `POST` responds `204` with no body, and an item action with `Prefer: return=minimal`,
    `204` with the `ETag`. Never `201` or `409`.
  - An `action` notice in `deprecations` gives `Deprecation` and `Sunset` and, once expired,
    `410 retired`.
- **relations (§9).** `include` with paths up to `include_depth` (1 if missing), only on relations
  with `"include": true`; `fields` with dotted paths, which require the `include` and a field that
  exists in the included item; to-many relations as lists, unpaginated; relations to several
  collections with `type`, whose `include` fills in the item from that collection (and does not
  allow going any deeper); a related item that does not exist stays as its `{id}`. Links to items
  of a subcollection carry `href`, which is kept when they are included, and is required on write:
  an `href` that is not the path of an item of that collection, or whose last segment is not the
  `id`, gives `422` at `/rel/href`; one that does not exist, `unknown` at `/rel/id`; only `id`,
  `type` and `href` are stored from each link. A to-many relation whose `path` is the template of
  a subcollection of the collection itself **leads to it**: it is not embedded in the
  representation (that is what the subcollection is for), with `include` it brings its items under
  that parent, and it is not written (ignored with its current value; `read_only` with another).
  A relation is replaced whole on write and its target is checked to exist; with its current value
  it is ignored. In `filter` and `sort`, a path through a to-many relation or one that ends in the
  `id` of an item of a subcollection is not served (with a warning) (§6.1).
- **Failures and latency.** `--fail-rate` responds `503 unavailable` before doing anything (a
  write that fails this way has no effect and does not use up its `Idempotency-Key`). The `status`
  resource does not go down, so a client can tell a transient API outage apart. Latency and
  failures are deterministic per seed in the order requests arrive.

## What draft 7 added

- **Errors (§5.4).** Every `code` comes from the closed table (`content_too_large` for `413`);
  `428`, `429`, `431` and `511` would carry `Cache-Control: no-store` (every error does) and no
  `CDN-Cache-Control`. A body with duplicate member names gives `400 bad_request` (§3).
- **Instants and durations (§3, §6.1).** Lowercase `t`, `z` and duration letters are accepted;
  durations follow the grammar of §3, with up to nine decimals in the seconds, and compare
  exactly, as decimals; a leap second gives `invalid_parameter`. New types `localdatetime` (the
  fields in `local_times`) and `timezone` (a field named `zone`, `timezone`… or the `zone` of a
  local time), generated, filtered and validated.
- **Localized fields (§3, §5.6).** Each field in `localized` is the text of its language map in the
  language of the response, picked by lookup (RFC 4647) over the map's tags, with
  `default_language` (added as `"en"`, with a warning, if missing) when nothing matches. Such
  responses carry `Content-Language` and `Vary: Accept-Language`; the item ETag differs by language,
  `If-Match` succeeds with that of any language, filters and sorting use the response language and
  the cursor is bound to it. Writing the field gives `read_only` unless it is its text in some
  language (then it is ignored).
- **Filters (§6.1, §6.2).** `nin`, `prefix` and `contains` (empty operand: `invalid_parameter`;
  with the field's collation); an operator outside the list, `prefix`/`contains` off a `string`, or
  `ne`/`nin` with `quantifier` are not served. `null` on a to-many relation or a list field itself,
  as its only operator, is served with or without `"quantifier": "some"`, as declared (both select
  the same), and with the type of the related items' `id` (`string`) or of the elements, with a
  warning if declared otherwise. `integer` and `number` operands, and those of `GET` action
  parameters (each element of a list too), follow the `number` grammar of RFC 8259 (`+20`, `.5`,
  `020` and `0x14` give `invalid_parameter`); an operand of an `integer` field is valid when its
  exact value has no fractional part (`20.0` and `2e1` are `20`; `20.5` gives
  `invalid_parameter`), and a cursor binds numeric operands by their exact value. `"quantifier": "some"` on a list field or on a path
  through one to-many relation (also one that leads to a subcollection): the filters of a group
  match when some related item or element matches them all, `null` tests the whole relation or
  list, never an element (`filter[rel][null]=true` or `filter[rel.x][null]=true` alone asks for an
  empty one, and negates the group otherwise); sorting by such a path uses the least (or greatest) value.
  Paths into an object of the item (`address.city`). A switch with `"default": true` applies unless
  `filter[name]=false`; a `"required": true` filter missing gives `invalid_parameter` naming it.
- **Writes (§5.1).** A field only the server sets is one no client can set, in a `POST` or a
  `PATCH`, and discovery cannot say which: neither `readOnly` in the `item` schema nor absence
  from `create` makes a field one. So the mock has none unless the discovery document lists them
  in its own collection member `"x-mock-server-only": ["created_at", "total"]` (served as it
  comes; clients ignore `x-` members). A `POST` ignores those whatever their value and a `PATCH`
  treats them as read-only; `id`, an effective field or a localized one is never one (warning).
  Any other `readOnly` field in a `POST` is ignored only as `null`, and otherwise gives
  `read_only`. `"upsert": true` (with
  `id_from` `client` or `either`): a `PATCH` to a free id creates the item (`201` with `Location`),
  `If-None-Match: *` only creates (`412` on a taken `id`) and `If-Match` only updates; the mock
  never requires `If-Match` (§7.2). `"reusable_ids": true` (with
  `client`): a deleted id is free again, and each incarnation has another ETag.
- **Uploads (§5.1).** A collection with `upload` takes the bytes of a file of a declared media
  type (`415` otherwise, `413 content_too_large` above `max_size`), or, with `"multipart": true`,
  `multipart/form-data` with exactly one part named `file` (its `filename` is optional). An outer
  `multipart/form-data` without `"multipart": true` gives `415`, even when `media_types` match it;
  any other multipart type is a file like any other. Without a `create` schema the mock
  takes the collection as one that does not create items from JSON (as restep-check does): a JSON
  body there gives `415`, unless `media_types` admit `application/json` (also as `application/*` or
  `*/*`), which makes it a file. A `+json` type such as `application/ld+json` is always a file.
  With a `create` schema, a `POST` with `application/json` is always an item, and a JSON file goes
  only as the `file` part of multipart: where `media_types` admits `application/json` (also as
  `application/*` or `*/*`) without `"multipart": true`, the mock serves it with multipart and warns.
  Every `415` of a collection with `upload` carries `Accept-Post` with what it takes
  (`application/json` only with a `create` schema, the declared types and, with multipart,
  `multipart/form-data`). The item gets `_content` (`href`,
  `media_type`, `size`), and `href` serves the bytes; generated items have made-up bytes. A
  `name`/`filename` field takes the `Content-Disposition` file name and a `media_type` field the
  type.
- **Singletons (§5.9).** One with `parent` hangs from an item (its path is a template that starts
  with the parent's item path) or from another singleton: one object per parent item, `404` under a
  parent that does not exist, removed with it. Singleton actions, at `{path}:{name}`.
- **Actions (§11.1).** A safe action that is not idempotent is not served. `params` of a `GET`
  action (`invalid_parameter` for a missing required one, a bad value, an empty list or a repeated
  one; `unsupported_parameter` for an undeclared one); with `output`, a made-up result of that
  shape, without `_etag`; `GET :new` gives `{"values", "schema"}` from the `create` defaults and
  schema; a safe collection action without `output` answers `204`, and a `204` carries no `ETag`.
- **Inheritance (§11.6).** `"combine": "fields"` resolves each member of an object on its own (own
  member, the linked item's effective member, the default's), and `_inherited` lists the inherited
  members under `fields`; a `switch` (a boolean field, given its `initial` value by a `POST`) stops
  anything from coming from above while it is `false`. Fields whose schema is an object of scalars
  are generated and validated against it.
- An unsafe action on a collection answers `204` (it creates nothing), never `200` (§11.1).
- **Discovery (§4.2).** `shared_cache`, reserved, is removed; `inherit_items` is not simulated and
  is removed (with a warning). `effects`, `method_effects` and `item_method_effects` are served as
  they come: they change no behaviour. A singleton's `method_effects` keeps only `PATCH`, and only
  where it supports `PATCH` (§4.3, §5.9); any other key is not served (warning).

## How it generates the data

Each value comes from its own generator for (seed, collection, item, field): same seed and same
discovery document give the same data, and adding a field does not change the others.

1. **Fields and types.** First the `item` (or `create`) schema from `schemas`, embedded or
   linked: `anyOf`/`type` with `null`, `format` (`date-time`, `date`, `duration`), decimal
   `pattern`, `enum`, objects with `id` (relations) and objects of strings (language maps). The
   type that `filter` declares for that field wins, and `language_maps`, `relations` and `inherit`
   say which fields are maps, relations and inheritances. Without a schema, the fields are the
   ones named by `filter`, `sort`, `language_maps`, `relations` and `inherit`, and any undeclared
   type comes from the name (`*_at` → `datetime`, `price` → `decimal`, `is_*` → `boolean`, `year`
   → `integer`…).
2. **Plausible values** by type and name: `email` (`ines.arriaga3@example.com`), person names in
   collections of people (`speakers`, `users`, `authors`…), room names in collections of places,
   `title`, `description`, `url`, `phone`, `city`, `country`, `currency`, `sku`, `isbn`, `status`;
   `price` and `amount` as decimals in strings, `tax`/`vat` among 4, 10 and 21, `rating` from 1 to
   5, `year`, `stock`; reasonable birth dates, `updated_at` after `created_at`, appointments in
   working hours and on quarter hours; durations without years or months. It respects the
   schema's `minimum`, `maximum`, `minLength`, `maxLength` and `enum`.
3. **Deliberate gaps**: 10 % of optional fields are `null` (so the `null` operator and the
   ordering of missing values have something to test), language maps have the tags the discovery
   document uses in `filter` and `sort` plus `en` and `es`, with missing translations, and some
   are empty.
4. **Relations** to items that exist: it generates parents and target collections first, and in
   a relation to the same collection it only links to earlier items, so there are no cycles. A
   link to an item of a subcollection picks a parent and an item, and carries its `href`; those
   links are filled in last, because the subcollection may hang from the collection itself (a book
   that features one of its reviews). If the subcollection hangs from the item itself or from one
   of its parents, the link stays under that same parent: a book's featured review is a review of
   that book. In an inheritance, the own field is usually `null` so that it inherits, and the
   default value (if `"default": true`) is generated once per collection and field.

The `id`s are `"1"`, `"2"`…, under each parent in a subcollection; created items continue the
numbering. `--dump` gives one list per collection and, for a subcollection, one per collection
path.

## What it does not simulate

It removes these from the discovery document it serves, and warns on standard error, so as not
to announce anything it does not honour:

- The `sync` profile and the `batch`, `filter-expr`, `query-method` and `oauth` extensions; the
  `sync`, `batch` and `events` members.
- Subcollections that do not meet §4.2 (above), and actions that do not meet §11.1.
- Singletons with a template but no `parent`, or whose path is not the parent's followed by literal
  segments (§5.9), a singleton under a singleton that itself has a parent, and relation or
  language-map fields of a singleton.
- An `id_from` with a value that draft 7 does not define.
- `inherit_items` (§11.6) and `shared_cache` (§4.2).
- `deprecations` notices with a `kind` out of place (expired ones for `field`, `value`,
  `relation`, `version`, `extension` and `reason` stay in `deprecations`, but their retirement is
  not applied).

Other limits:

- An `integer` or `number` operand (of a filter or a `GET` action parameter) is `0` or has a
  magnitude from `1e-300` to `1e300`; over that, `invalid_parameter` with the limit in `detail`
  (§5.3, §6.1). Within it, it is compared as a number, even outside the field's range.

- Schema validation covers types, `required`, `enum`, `minimum`, `maximum`, `minLength`,
  `maxLength` and `pattern` of top-level fields; not `allOf`, `$ref`, nested objects or `format`
  beyond dates and durations.
- It accepts any well-formed tag in a language map (it never gives the `unknown` code of §3).
- The logic of actions: they change no data, create nothing (`201`) and give no `409` based on the
  item's state, and it does not put `_actions` in representations (it is a MAY).
- An action without `output` answers with the affected item (`200`) or `204`; with `output`, with a
  made-up result of that schema. An unsafe collection action never answers `200` (§11.1).
- A relation to a collection that is not in the discovery document (or is omitted) is `null`.
- Discovery texts stay in the language they came in; only errors change with `Accept-Language`
  (English and Spanish).
- Idempotency and writes live in memory; the cursor is not bound to the principal.
- There are no credentials: no response depends on them (so `private` is not needed, §5.1), there
  is no `401` or `403`, nor the `Origin` check of §5.8, and every idempotency key belongs to the
  anonymous principal unless the request carries `Authorization`.
- On a `POST`, a read-only field not listed in `x-mock-server-only` is ignored only as `null`: the
  mock does not know the value the item would get; one listed there is ignored whatever its value
  (§5.1).
- Whether a collection with `upload` creates items from JSON is read from its `create` schema
  (declared: it does), since discovery has no member for it (§5.1).
- It does not set `service-doc` (§4.2): it does not know the documentation of the API it
  simulates (restep-check warns about it).
- It never gives `429` or `503` to a request with an effect: simulated failures come before doing
  anything.

## Tests

```bash
node tools/restep-mock/test.mjs     # from projects/restep; uses ports 8828-8839
RESTEP_REF=/path/to/restep-server.mjs node tools/restep-mock/test.mjs   # another copy of the reference
```

It starts the reference server, saves its discovery document, starts the mock with it and runs
`vendor/restep-check.mjs --writes`; it does the same with `test/agenda.json`, a
discovery document of its own with dates, instants, durations, booleans, `relations` with
`include`, a to-many relation, a linked schema, an action and what the mock does not implement
(`sync`); and with `test/biblioteca.json`, made up, with two-level subcollections, item and
collection actions (`POST` with `input`, `GET`, idempotent or not, and the ones the text
forbids), a relation to items of a subcollection, another that leads to a subcollection and a
polymorphic one. It also tests the seed, `--fail-rate`, `--latency`, `--count` per collection,
usage errors and the draft 6 additions: the `shop` singleton, no `Deprecation` when sorting by
`year` (a partial notice, since draft 7), media types, `id_from`, `taken`, collations, the query in `Idempotency-Key`, the declared
version, announced `inherit`, expired retirements, undeclared `limit` and `count` and
`"anonymous": false`; and, in the library, paths under parents that do or do not exist, cascading
`POST` and `DELETE`, links with `href` (without it, with another `id`, to something that does not
exist), `include` and dotted `fields` through subcollections and through a polymorphic relation,
and each of the action rules above. With a discovery document of its own it also tests that links
to a subcollection do not change parent, that `include` fills them in and that a collection
without `GET` gives `405` to `HEAD` too. A last discovery document of its own covers each rule in
"What draft 7 added" above (port 8828), and the reference's `/me:verify_email` covers singleton
actions.

Current result (restep-check at draft 7, 24 November 2026):

```
restep-check against the reference mock:  0 failed · 1 warning · 1159 passed · 242 skipped
restep-check against the agenda mock:     0 failed · 1 warning · 298 passed · 38 skipped
restep-check against the library mock:    0 failed · 1 warning · 309 passed · 51 skipped
0 failed · 198 passed
```

The warning is `discovery.service-doc` (above). The `skip`s come from restep-check, not the
mock: things that need credentials or CORS, collections without date fields, without `id_from`
or without `readOnly` fields, and the like.

## Open questions about the spec

Draft 7:

- **"Only the server sets" (§5.1).** Settled by the council: discovery does not say which fields
  those are, so the mock takes only those its `x-mock-server-only` member lists (Writes, above).
- **A collection that only takes uploads (§5.1).** It answers JSON with `415`, but discovery has no
  member that says a collection with `upload` does not create from JSON; the mock, like
  restep-check, reads the absence of a `create` schema as that, which §4.3 does not promise.
- **A localized field in a `POST` (§5.1).** "The value the item would get" is its map's text in
  the response language; the mock ignores it with the text of any language of the map sent, or
  `null`.
- **`null` on a group with `false` (§6.1).** `filter[reviews][null]=false` together with other
  filters of the group: the mock reads it as the group alone (some related item matches, so there
  is some).

Earlier:

1. **A collection's `path` and the API root.** The discovery schema says `path` is "relative to
   the API root, starting with /", but §3 requires body links (`next`, `href`) and §4.3 requires
   `schemas` links to be absolute paths that include the root's path. With a root at `/api/`, it
   is unclear whether `books` is declared as `/books` or `/api/books`. The mock always serves at
   `/` and is not affected, but a client does need to know.
2. **Filters through a to-many relation.** Settled in draft 7: a path through one to-many relation,
   or a list field, is declared with `"quantifier": "some"` (§6.1).
3. **How far `count: "estimated"` may be off.** §6.5 sets no limit; the mock rounds to the
   nearest ten. A rough bound (or saying there is none) would help whoever writes tests.
4. **Service status and API `503`s.** §4.4 says `status` gives `503` when the API cannot serve,
   but not whether a single `503` from a resource (a transient failure) should be reflected
   there. The mock keeps `status` at `200` during simulated failures.
5. **Types of fields that are not filtered.** Discovery only declares types in `filter` (§4.2)
   and the full shape goes in `schemas`, which is optional. Without schemas, a generator or a
   typed client has no way to know which fields an item has, nor the types of those that are not
   filtered or sorted; the mock guesses them from the name.
6. **Which version a mock declares (§1.1, §1.2).** A server implements the text of the version
   it declares. The mock serves another API's discovery document, which may declare `1.0` or an
   earlier draft; so as not to lie it always declares `1.0-draft.7`, even though that changes the
   document the client expected.
7. **Expired retirements still in `deprecations`.** §5.5 says how the retired thing responds,
   but not whether the notice stays in discovery after the `sunset`. The mock keeps it (with the
   retired thing no longer declared), so it is visible why it is missing.
8. **"The value the item would receive" (§5.1).** On a `POST`, a read-only field is ignored if
   it carries that value, but for a field the server sets (`created_at`) the client cannot know
   it. Draft 7 settles it: such a field is ignored whatever its value (see "Writes" above).
9. **The relation that leads to a subcollection (§9).** "The relationship that leads to one MAY
   carry the same template in its path": it does not say whether that relation is embedded in the
   parent's representation. If it is, it is a list that grows without bound, exactly what §9 says
   should be a subcollection; and a `POST` that copies an item it read would carry another
   parent's list. The mock does not embed it, fills it with `include` and treats it as read-only.
   Nor does it say whether a relation to a subcollection **without** `path` also "leads to it":
   the mock treats it as an ordinary relation to individual items, with `href`.
10. **What a simulated action responds (§11.1).** The text allows `200` (the affected resource),
    `201` and `204`, but does not say what "the affected resource" of a collection action is, nor
    whether a `GET` action may respond with something else. Draft 7 adds `output` for safe actions
    and forbids `200` for unsafe collection actions; without `output`, the mock responds with the
    item or `204`.
11. **Malformed key on an idempotent action (§7.1, §11.1).** "MUST NOT reject a request because
    it carries a well-formed `Idempotency-Key`" does not say what to do with a malformed one. The
    mock ignores it, like any key on an idempotent action.
12. **`include` through a polymorphic relation (§9).** `include=featured.books` when `featured`
    goes to two collections: is it valid if each link's `type` has `books`? The mock gives
    `unsupported_parameter`.
13. **More than one level of subcollections (§4.2).** The text allows it
    (`/authors/{author_id}/books/{book_id}/reviews`), but does not say whether a path with more
    literal segments after the variable (`/authors/{author_id}/x/books`) is valid. The mock
    accepts it if there are no more variables.

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-mock>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://w3id.org/restep/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
