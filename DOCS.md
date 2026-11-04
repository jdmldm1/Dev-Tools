# dev-tools: full documentation

Dark-mode cheat sheets and browser-based developer tools. No build step, no server required, and nothing leaves the page.

Open `index.html`: it goes straight to the XSD Schema Explorer (`toolbox.html#xsd`); the NATS Explorer is `toolbox.html#nats`. `all.html` is the searchable overview of every sheet and tool. Groups on the landing page and in the toolbox sidebar are collapsible (state is remembered); searching opens just the groups that match, and the toolbox sidebar also lists every cheat sheet.

## Cheat sheets (`sheets/`)

| Group | Sheets |
|-------|--------|
| CLI & DevOps | Git, GitHub CLI, GitLab CLI, Docker, kubectl, NATS, Terraform, Helm |
| Shell & System | Linux & SSH, Bash, PowerShell, curl, jq, Vim, Make & CMake |
| Languages & Data | Go, C#, Rust, Python, JavaScript, TypeScript, SQL, PostgreSQL (psql, JSONB, SQLite notes), Regex |
| Web | HTTP, React, Svelte, Markdown |
| XML & Mission Systems | XML / XPath / XSD, UCI · OMS · AMS GRA (repos, versions, and what the UCI 2.6 schema contains) |

Every sheet has a filter box, section chips and click-to-copy commands. The overview (`all.html`) also searches the commands inside every sheet and links to the sheet pre-filtered (`sheets/<id>.html?q=...`).

## Toolbox (`toolbox.html`)

| Group | Tools |
|-------|-------|
| Format & Validate | JSON formatter / validator (line + column errors), Regex tester (worker timeout guards against catastrophic backtracking), Text diff |
| Encode & Decode | Base64 (text + files), URL encode / decode / parse, Escape / unescape (HTML, XML, JSON, JS, regex, SQL, shell, CSV, Unicode) |
| Translate | JSON ⇄ YAML, CSV ⇄ JSON, JSON → code types (TypeScript, Go, C#, Python, Rust), curl → fetch / Python / PowerShell / Go / C#, **HTTP request builder** (method, headers, auth, body → curl / fetch / Python / PowerShell / Go / C#), **Protobuf viewer** (.proto outline, field-number lint, proto3 JSON sample) |
| Generate | UUID v4 / v7, ULID, random keys, password generator, **QR code generator** (text, URL or Wi-Fi; SVG and PNG; own encoder, versions 1-40, checked against a reference library) |
| Time & Numbers | Timestamp converter, Cron explainer (+ next runs), Number bases & bits, Color converter + WCAG contrast |
| Text | Case converter, Text utilities (sort, dedupe, number, join, split, replace, counts), **Unicode inspector** (code points, UTF-8/16 bytes, invisible and bidi characters, normalization) |
| UCI | **XSD Schema Explorer & Validator**, **Schema Diff**, **Message Builder**, **UCI Traffic Lab**, **NATS Explorer**, **CAL Explorer (OWP)** |
| Network & Security | JWT decoder + HMAC verify, Hash & HMAC, **TOTP / 2FA code** (RFC 6238, otpauth:// URIs), chmod calculator, CIDR / subnet calculator |
| XML & Mission Systems | XML format / validate / convert, Coordinates / distance / units, Bytes (hex dump, endianness, CRC) |

Deep link to a tool with `toolbox.html#jwt`, `toolbox.html#xsd`, etc.

### Shell features (all tools)

- **Share links.** "Share link" copies `toolbox.html#tool?s=...`: the tool's changed inputs, deflated and base64url-encoded. Opening it restores them. Links over about 6 KB are refused (copy the text instead). UCI tools (NATS, CAL, Traffic Lab and so on) and password / secret / token fields are never put in a link; mark any field `data-noshare` to keep it out.
- **Send output to…** moves a tool's output into another tool's input (for example Base64 → URL, JWT payload → JSON).
- **Command palette.** `Ctrl/Cmd + K` jumps to any tool or sheet or runs an action (copy share link, switch theme, expand or collapse the sidebar). `/` still focuses the sidebar search.
- **Theme.** Dark by default; the sidebar's `theme:` button cycles dark, light and auto (follows the system). Sheets, the overview and the older standalone sheets follow the same setting. Printing a sheet uses a plain black-on-white layout.
- **Offline.** A service worker precaches every script, stylesheet and sheet the pages reference, keeps them in a cache named after the version in `package.json`, and shows a "new version is ready" toast when an update is installed. Install it from the browser as an app (`manifest.json`).
- **Accessibility.** Controls without a label get an accessible name automatically (placeholder, nearby text, or id), status lines are live regions, and there is a skip link. The smoke test fails if any tool has an unnamed control.

### XSD Schema Explorer & Validator

Built against the UCI 2.6 schema release (`UCI_MessageDefinitions`, `UCI_SecurityMarkings`, `UCI_Versioning`; ~8 MB, 725 messages, 5,571 types) and general enough for other schema sets.

- **Load**: choose files, choose a folder, or drop files / a folder onto the page. Select every `.xsd` of the set together so `xs:include` resolves; the status line names any file that is missing. "Remember in this browser" keeps the schema in local storage so it reloads instantly next time ("Forget" removes it). Loading the full UCI set takes about half a second.
- **Explore**: ranked search across messages, types, members and enumeration values (optionally across the documentation text too), filter by kind, type category or message family (`…Status`, `…Command`, …), back/forward history, and click-through links between types.
- **Diagram**: a graphical composition view, and the default for messages. The message is a box on the left and its members fan out to the right; click a box to open or close it. Compositors are explicit (a *choice* node with its alternatives), optional members have dashed edges, repeating ones carry occurrence badges (`0..8`, `1..∞`), enumerations open into their values, recursion is marked rather than followed, and inherited members carry an ↑. A message's shared header and security boxes start collapsed so its own payload is what you see. *Find* opens just the branches that lead to a member or type and steps through the matches (Enter, or ‹ ›). Pan by dragging, zoom with the wheel, *Fit*, and save as SVG or PNG. Click a box for its documentation and a link to its type.
- **Other tabs**: *Members* (every field including inherited ones, with its documentation, occurrence counts and choice markers), *Structure* (lazy expandable tree of a whole message; copy as outline or as a flat list of paths for mapping), *Used by* (members using a type, derived types, and which messages contain it, so "where is this enumeration used?" is one click), *Values & facets* (enumerations with their per-value documentation, copyable as TSV), *Sample XML*.
- **Sample XML**: a schema-valid message for any message or type: required elements only or everything, with optional hint comments listing enumeration values and choice branches. Honors patterns, length and range facets, unqualified/qualified namespaces, abstract types and recursion.
- **Validate**: paste or open an XML message and get every error with line, column, path and a message that says what was expected (`unexpected element <X>; expected one of: …`, `"NOPE" is not one of the 4 allowed values: …`). Click an error to select its line. It validates as you type.
- **Schema info**: files, versions, namespaces, and every problem (missing includes first, then the unresolved references they cause).

How trustworthy is the validator? It is cross-checked against .NET's `System.Xml.Schema` (see Tests). Where the XSD spec and .NET disagree, the choice is documented: `+5` on unsigned types, `24:00:00`, and a few leniencies are listed in `tests/crosscheck-zoo.js`. It does not check identity constraints (`xs:key`, `xs:unique`) or XSD 1.1 assertions, and treats `xs:all` as "any order within each member's limits" with correct required / duplicate checks. For formal conformance also run `xmllint` or .NET (commands are on the XML cheat sheet).

### NATS Explorer

Talks to a NATS server over WebSocket or standard NATS TCP (e.g. `nats://localhost:4222`, bridged via the dev-tools server `/nats-proxy` or `node scripts/nats-proxy.js`). For direct WebSocket connections without a bridge, the server needs a `websocket { port: 8080 no_tls: true }` block; the tool shows the snippet. A small NATS client lives in `assets/tools/nats.js`: no external libraries and no TLS. Authentication: user/password, token, **NKey seed** and **.creds files** (`nats-auth.js`: the page signs the server's nonce with Ed25519 via WebCrypto, so it needs Chrome 137+, Firefox 129+ or Safari 17+; the key stays in the page and is never saved).

- **Auto-connect**: opening the page reconnects to the last server you connected to without credentials (checkbox next to Connect to turn it off).
- **Live**: subscribes to `>` on connect (hiding `$JS.*`, `$SYS.*` and `_INBOX.*` unless you untick it); add or remove subscriptions as chips (overlapping ones are refused so nothing shows twice). One screen holds the stat tiles, messages/second, busiest subjects, message types, the feed (newest first, last 2,000 kept, filter by text or message type), the message detail, a collapsible **subject tree** (counts per token) and **plot a field over time** (any numeric JSON or XML field, up to 6 series). Click a bar to filter the feed; hover for values.
- **UCI / XML decoding**: load the schema (files or folder; it is the same saved schema the XSD Explorer remembers) and any XML message is matched by its root element name, so **any UCI version works**; a namespace difference is shown as a badge instead of blocking. The **Decoded** view shows the message name, its family and documentation, schema-valid or the list of errors, the header facts (SystemID, Timestamp, SchemaVersion, Mode), and the whole message as a collapsible tree with each element's type, cardinality, documentation (click the name), the meaning of every enumeration value, unknown elements flagged, and each validation error shown under the element it belongs to. Also an **XML** tab (pretty-printed) and **Raw**. Roots that are not in the schema get "closest names" suggestions. Messages without a schema still get the tree.
- **Publish & Request**: text, validated JSON or hex payloads, headers, reply-to; request/reply with a timeout and a clear "no responders" error. With a schema loaded: pick a message, **Generate sample** (required fields only, or everything) and **Validate**; publishing warns when a message has schema errors. "Edit as new message" in the detail view sends a received message here.
- **JetStream**: account usage, streams (with size and message charts), per-stream state and config, subjects with counts and a chart, consumers with a backlog chart (pending, ack pending, redelivered), look up a message by sequence or last-on-subject. KV buckets show their keys without the `$KV.<bucket>.` prefix, values, and delete/purge markers. XML values and messages decode the same way. An optional domain field handles `$JS.<domain>.API`.

**How much traffic it takes.** Measured in headless Chrome against a local nats-server with the explorer subscribed to `>`, schema loaded, filter and a plotted field active: ~500,000 msgs/s of small JSON (3 million messages in 6 s, none lost, page stays responsive within ~35 ms), ~130,000 msgs/s of 900 B UCI XML and ~120,000 msgs/s of 1 KB messages (about 120 MB/s, limited by the load generator, not the page), and ~300,000 msgs/s spread over 50,000 distinct subjects (~75 MB of heap). What keeps it fast: nothing on the hot path touches the DOM; the feed redraws at most every 120 ms; message decoding and validation happen only for the message you open. Above ~20,000 msgs/s the feed shows every Nth message (the status line says so) while counts, rates, charts and the type/subject statistics stay exact; the feed keeps the last 2,000, and at most 50,000 distinct subjects are tracked (the tile shows `+` past that). Limits to know: a server drops a client that cannot keep up (slow consumer), so on a very busy bus subscribe to the subjects you need instead of `>`; a background tab is throttled by the browser; plotting a field parses at most 25 messages/s per series. `node scripts/nats-blast.js 100000 10 json` generates load against your own server to check (kinds: json, json1k, xml, many).

`node scripts/nats-demo.js ws://127.0.0.1:18080` feeds a server with sample traffic to look at: UCI messages generated from the schema (`uci.<system>.<Message>`, about 1 in 12 deliberately invalid), sensors, logs, orders, request/reply services, JetStream streams and consumers, and KV buckets. It uses `UCI_SCHEMA_DIR` (or the folder named below), else a small demo schema.

**Profiles and alerts.** The "Profiles & alerts" section above the schema loader saves a connection profile (URL, subscriptions, hide-internal switch; never credentials) in this browser, with export and import as JSON. Alerts watch subjects while connected: "rate above N msg/s" (average over 5 s) and "silent for N seconds". They show a red banner and a toast when they start firing.


**More in the NATS Explorer** (tabs beside Live, Analyze, Publish and JetStream):

- **Alerts** now also watch content: "payload contains" (text or /regex/), "field query" (`Latitude > 34 and SystemID = alpha`) and "fails schema", with a history of what fired. They live in the Profiles & alerts section (shared with the CAL Explorer).
- **Feed filter**: besides text, type `where <field query>` (for example `where temp > 30`) to filter on values inside JSON, XML and OMS JSON. A path may be just its end: `Latitude` matches `Pos.Point.Latitude`; `topic ~ alpha` filters on the subject; `and` / `or`; ops `= != > >= < <= ~ exists`. The feed starts with the newest 300 rows and adds more as you scroll, up to everything kept.
- **Message diff**: open a message in the feed and use *Diff with previous* (the last message on the same subject) or *Mark for diff* then *Diff with marked*. JSON, XML and OMS JSON compare field by field; other text compares line by line.
- **Latency**: request/reply latency from what is on the bus. A message with a reply-to subject is a request; the next message on that subject is its reply. Per request subject: counts, unanswered after a timeout, no-responders, and p50/p95/p99/max. Times are this page's receive times.
- **Server** (`$SYS`): servers (version, connections, subscriptions, messages, slow consumers, CPU, memory, health), every connection (sorted by pending bytes to find slow consumers) and a **subject usage map**: other clients' subscriptions joined with the traffic seen, listing subjects that have traffic but no other subscriber and subscriptions that are idle. Needs a user from the server's **system account** (an application account gets an explanation and partial data).
- **KV & Objects**: pick a bucket. KV: keys, values, revision history, a live **watch**, and (after ticking *allow changes*) edit with compare-and-set (a stale edit is refused), create, delete and purge. Object store: list, and download with a size and SHA-256 check. Objects are read only.
- **JetStream administration**: *allow changes* (off by default) unlocks creating streams, purging (everything, one subject, keep the newest N, or below a sequence), deleting a stream or message, adding and deleting consumers, and **republishing** a range of stored messages onto another subject. Every destructive action asks first. The stream view also draws **consumer lag over time** (sampled every 2 s) and flags consumers whose backlog keeps growing, that are redelivering, or that have work waiting while nothing moves.
- **Responder**: rules that answer incoming messages automatically (match on subject, message name and a field query; reply with a template: `{{in:Field}}`, `{{uuid}}`, `{{now}}`, `{{counter}}`, `{{rand:1-100}}`, `{{pick:a|b}}`, `{{replyto}}`). A rule without a reply subject answers the request's reply-to. It ignores its own replies and is capped at 50 per second.
- **Scenario**: a list of messages with a delay before each; capture one from the live feed, edit, run at 0.5x to 10x or without delays, loop, export and import as JSON. Variables (`{{var:name}}`) come from a JSON object.
- **Profiles** also remember the feed filter.
### CAL Explorer (OWP)

The NATS Explorer's counterpart for the OMS **Language-Agnostic CAL** (OMSC-SPC-013): it speaks the OMS WebSocket Protocol 1.0 (subprotocol `owp`: INIT, INFO, SUB, UNSUB, PUB, MSG, +OK, -ERR) and the OMS JSON message format, in `assets/tools/cal-owp.js` (protocol, client, OMS JSON ⇄ XML mapping) and `cal.js` (the page).

- **Connect**: URL, service identifier, schema version (filled from the loaded schema's `version`) and OWP versions. The protocol cannot list these, so they must match the server's own configuration; the page explains each refusal (Unsupported-Version / -Schema / -Service, a server that closes without INFO, a missing `owp` subprotocol).
- **Live**: subscriptions are a **topic plus a message name** (no wildcards exist in OWP), with an optional group. Because nothing is delivered until you subscribe, there are four ways to get going: add them one by one; paste a list (`topic MessageName [group]`); let the page **resubscribe to last time's list** on connect; or **subscribe to everything the server advertises**. OWP cannot list topics, but a server may put a non-standard `x_topics` array (`[{ "name": "...", "message": "..." }]`) in INFO; this page subscribes to all of them on connect and to any added later (another INFO), with a button and a checkbox to control it. The mock server below does this. For servers that do not, **Discover…** takes candidate topic names and tries the schema's messages on each (pipelined; a refused SUB is skipped, an accepted one stays), so you only need to know topic names. Same feed, filters, stat tiles, rate / busiest-topics / message-type charts as the NATS Explorer.
- **Decoding**: each message is mapped to XML with the loaded schema (member order, arrays, `$type` as xsi:type, exact number text so 64-bit values survive) and shown with the shared decoded view: documentation, enum meanings, types and cardinality, header facts, inline schema errors. Tabs for pretty JSON, the XML, and raw. Any schema version works.
- **Publish**: pick a message, **Generate sample** (MessageHeader filled from INFO: system and service UUIDs, current timestamp, mode LIVE), **Validate** (errors by schema path), Publish; the server's +OK or -ERR code comes back with a plain-language explanation. Server tab: INFO contents and a protocol log of the last 200 frames.
- **Auto-connect**: opening the page reconnects to the last server and restores the subscriptions (switch off with the checkbox next to Connect).
- **Presets**: save the current subscriptions, connection details (there are no secrets in OWP) and feed filter under a name; load, delete, export and import as JSON.
- **Alerts**: the same engine as the NATS Explorer with the topic and an optional message name: rate, silence, payload contains, field query and fails schema.
- **Responder** and **Scenario**: as in the NATS Explorer, publishing through the server (a responder can stand in for a service that answers commands, and a scenario can replay a recorded exchange).
- **Feed filter**: `where <field query>` works here too (`where MessageData.State = ACTIVE`).
- **Analyze** adds **Search** and **Conformance** (see the Traffic Lab).
- Limits: live only (the protocol has no history or replay), servers that need authentication headers do not work from a browser, and children of non-qualified schemas are written without a namespace prefix when validating.

`node scripts/owp-mock-server.js --nats ws://127.0.0.1:18080` runs the same server as a read-only view of the UCI XML messages on a NATS server (topics are the subjects, e.g. `uci.alpha.SystemStatus`; non-UCI subjects are ignored). Without `--nats`, `node scripts/owp-mock-server.js` runs a small LA-CAL server (port 9000, service `DemoService`, the loaded schema's version) that enforces the protocol rules and publishes generated UCI messages on topics such as `sys.status` (SystemStatus) and `mission.plan` (MissionPlan); it is also what the tests use.

### UCI tools built on the schema and the traffic

All of these live in the **UCI** group and share the schema you load (it is remembered in the browser and shared with the XSD, NATS and CAL explorers).

**Schema Diff** (`schema-diff-lib.js`, `schema-diff.js`). Load an older and a newer XSD set (for example UCI 2.5 and 2.6) and get added, removed and changed messages, types, members and enumeration values. Each change is rated from the point of view of a system built on the **old** schema: *breaking* (something removed, narrowed, retyped, a new required member, a smaller maximum), *review* (a pattern changed, member order changed, a choice reshaped, a type replaced by one that restricts it), *additive* (new message, new optional member, new enumeration value, a wider limit) and optionally *docs*. Messages are listed with the changed types that reach them, and **Root causes** ranks the changed types by how many messages they touch, so a handful of shared types settle most of a 700-message list. Export as Markdown or CSV. On the real 2.5 and 2.6 sets it runs in about 70 ms (for example: every message is reached by a string pattern change from `{0,1024}` to `{1,1024}`, 99 by new `OrbitRegimeEnum` values).

**Message Builder** (`msg-builder.js`). A form generated from the schema: required members always present, optional ones behind checkboxes (built only when switched on, so large messages open instantly), choices as radio sets, repeating members as lists with add and remove, abstract types as a subtype picker, enumerations as dropdowns that show each value's meaning, and buttons for "now" on timestamps and "new id" on UUIDs. The XML, the OMS JSON and the validation result update as you type. **Fill header** sets the system id (remembered), service id, timestamp and mode. **Publish in NATS Explorer / CAL Explorer** hands the message to that explorer's publisher. Editing an existing message back into the form is not supported.

**UCI Traffic Lab** (`uci-lab.js`, `traffic-lab.js`, `uci-analysis.js`). Load captures (`.jsonl`: one JSON object per line with a time, a subject or topic and the message text; XML and OMS JSON both work, several files are merged by time) and look at them with four views. The same four views are the **Analyze** tab inside the NATS and CAL explorers, fed live.
- **Bus**: who is talking, by MessageHeader SystemID: message counts, types, rate over the last minute, first and last seen, and quiet systems flagged.
- **Transactions**: messages that mention the same identifier belong together (a command and its statuses, a plan and its status). Pick one for a timeline with the time between messages, the states each reported (`NEW → ACCEPTED → COMPLETED`), a swim-lane chart by message type, and where the id sits in each message. Very common identifiers can be hidden.
- **Analysis**: validity per message type with the most common problem, messages unknown to the schema, duplicates, out-of-order timestamps, latency (receive time minus header Timestamp), silences in a stream (longer than 5 times the usual interval), schema versions seen.
- **Map**: every Latitude/Longitude pair (UCI radians, or lat/lon degrees in plain JSON; exactly 0,0 means "no fix" and is skipped) becomes a track per entity on an offline world map (Natural Earth, public domain) with trail length, pan and zoom, a legend, hover details, and a time slider with Play for captures.
- **Search**: find messages by field values across the whole recording (`Latitude > 34 and SystemID.UUID ~ 1111`, `topic = x`, `Status = FAILED or Status = ERROR`), open a hit, export the matches as a capture.
- **Conformance**: pass / fail per service (MessageHeader ServiceID, else SystemID) with the most common problems, and a downloadable **report** (Markdown or a standalone HTML page): summary, who was on the bus, message types and validity, conformance, slowest transactions, silences.
- **Compare** (Traffic Lab): load a second capture and see message types, systems and topics that appeared or vanished, rates, invalid counts and latency side by side; download as Markdown.
- **Live source** (Traffic Lab): stream a running NATS server or LA-CAL straight into the lab; every view keeps updating while messages arrive.
- **Replay** (in the Traffic Lab only): play the capture into a NATS server or an LA-CAL at the original timing, 2x, 5x, 10x or as fast as possible, with a filter, looping, conversion to the target's format (XML for NATS, OMS JSON for a CAL) and an option to stamp each header with the current time. Refusals are counted and the last reason shown.

Decoding is done in time slices so the page stays responsive, up to 200,000 messages in the Lab and the newest 20,000 in an explorer's Analyze tab. "Save capture" in an explorer writes the file the Lab reads, and "Open in Traffic Lab" hands the recording over directly.

## Running the demo environment

Three small programs give the NATS and CAL explorers something real to look at: a NATS server, a publisher that feeds it, and an LA-CAL server that serves the UCI messages found on NATS. Open four terminals in the repository root (Node 18+ is the only other requirement; the scripts have no dependencies).

**1. A NATS server with WebSocket and JetStream.** Install `nats-server` (a release binary from https://github.com/nats-io/nats-server/releases, or `docker run` it), then save this as `nats.conf`:

```
port: 4222                     # plain TCP, used by nats-blast.js and normal NATS clients
jetstream { store_dir: "./js" }
websocket {
  port: 18080                  # what the browser connects to; pick any free port (8080 is often taken)
  no_tls: true                 # development only
}
```

```
nats-server -c nats.conf
```

**2. The NATS demo publisher.**

```
node scripts/nats-demo.js ws://127.0.0.1:18080
```

Six simulated systems (`alpha` to `foxtrot`) also fly wandering courses and publish a `PositionReport` every second on `uci.<name>.PositionReport`, for the Traffic Lab map. It creates the JetStream streams (`ORDERS`, `EVENTS`, `UCI`), consumers and KV buckets (`config`, `sessions`, `uci_registry`), then keeps publishing until you press Ctrl+C: sensors, logs, orders, events, request/reply services (`svc.time`, `svc.echo`, `svc.sum.*`, `svc.uci.status`), and UCI XML messages on `uci.<alpha|bravo|charlie>.<Message>` (about 1 in 12 deliberately invalid). The UCI messages are generated from a schema: it uses `UCI_SCHEMA_DIR` if set (the folder with the `UCI_*.xsd` files), else the copy in your Downloads folder, else a tiny built-in demo schema. Set it explicitly if yours lives elsewhere:

```
UCI_SCHEMA_DIR=/path/to/UCI_schema_folder node scripts/nats-demo.js ws://127.0.0.1:18080          # bash
$env:UCI_SCHEMA_DIR = "C:\path\to\UCI_schema_folder"; node scripts/nats-demo.js ws://127.0.0.1:18080   # PowerShell
```

**3. The LA-CAL mock server, backed by NATS.**

```
node scripts/owp-mock-server.js --port 9100 --nats ws://127.0.0.1:18080
```

Read-only view of the UCI XML messages on NATS (subject `uci.>`), served over OWP as OMS JSON. Topics are the NATS subjects (`uci.alpha.SystemStatus` and so on), the service identifier is `DemoService` and the schema version is read from the schema (`002.6.0` for UCI 2.6). Options: `--service`, `--schema`. Leave out `--nats` to get a standalone server that generates its own traffic on topics like `sys.status` instead (`--interval` sets the pace, default 1000 ms).

**4. Open the explorers** (`index.html` or `docker run`, then the sidebar):

| Explorer | URL | Also enter | Then |
|---|---|---|---|
| NATS Explorer | `ws://127.0.0.1:18080` | nothing | Connect (it subscribes to `>` itself); "Load folder…" with the UCI schema to decode `uci.*` messages |
| CAL Explorer | `ws://127.0.0.1:9100` | service `DemoService` | "Load folder…" with the UCI schema (fills in the schema version), Connect, then "Paste list…" with lines such as `uci.alpha.SystemStatus SystemStatus` |

The schema is remembered in your browser and shared by both explorers and the XSD Explorer. Messages are spread over 27 subjects, so any single topic is quiet: subscribe to several. To stop everything press Ctrl+C in each terminal. To check how the NATS Explorer copes with load, `node scripts/nats-blast.js 100000 10 json` publishes to port 4222 (see "How much traffic it takes" above).

## Docker

```
docker build -t dev-tools .
docker run --rm -p 8080:8080 dev-tools        # http://localhost:8080   (use -p 8000:8080 if 8080 is taken)
```

The image is about **1.2 MB** (`docker save` size; `docker images` may show double on newer Docker because it counts the multi-platform index). It is `FROM scratch` with a single binary: the site gzipped and embedded in a small static Go server (GET/HEAD only, ETag revalidation, gzip for clients that accept it, nosniff and frame-deny headers, `/healthz`, graceful SIGTERM, runs as an unprivileged user, ~5 MB of memory). The build stage runs `go vet` and the server tests, stages only the files that are served (see `.dockerignore`), and UPX-packs the binary. `PORT` or `-addr` change the listen address. There is no TLS: put it behind your usual proxy, and remember a page served over https can only open `wss://` NATS URLs.

The pages run in your browser, so the NATS WebSocket address you type is resolved from your machine, not from the container. The server code is in `docker/server`; to run its tests without Docker, copy the served files into `docker/server/www` and gzip them (the Dockerfile shows how).

**Zarf.** `zarf.yaml` packages the image with a Deployment and Service (non-root, read-only filesystem, `/healthz` probes) for air-gapped Kubernetes: `docker build -t dev-tools:1.4.0 .`, `zarf package create .`, `zarf package deploy zarf-package-dev-tools-*.tar.zst --confirm`, then `kubectl -n dev-tools port-forward svc/dev-tools 9999:9999`. Keep the image tag in `zarf.yaml` and `zarf/dev-tools.yaml` equal to `package.json`.

## Layout

```
index.html            redirects to the XSD Schema Explorer
Dockerfile            ~1.2 MB scratch image (server in docker/server)
zarf.yaml            Zarf package (image + Deployment/Service in zarf/dev-tools.yaml)
scripts/              nats-demo.js (sample traffic), nats-blast.js (load generator)
all.html              overview of every sheet and tool (search + collapsible groups)
catalog.js            list of sheets and tools shown on the landing page and in the sidebar
toolbox.html          tool shell (collapsible sidebar + hash router)
sw.js, manifest.json  offline service worker (version must match package.json) and install manifest
sheets/*.html         one page per cheat sheet
assets/
  theme.css|js        shared theme (dark default, light, print); theme.js runs in <head> and remembers the choice
  groups.js           collapsible groups with remembered state
  shell.js            share links, send-to, command palette, toast, accessible names (built on hooks in toolbox.js)
  sheet-index.js      turns a sheet page into searchable rows for the overview's command search
  tools/payload-tools.js alerts.js scenario.js scenario-ui.js capture-tools.js lab-extras.js   field queries and diff, alert rules, templates and scenarios, capture diff and reports, Traffic Lab tabs
  tools/nats-panels.js nats-js.js nats-latency.js nats-auth.js nats-ops.js bridge.js cal-panels.js   the NATS and CAL explorer extras, JetStream and KV helpers, NKey auth, Bridge Compare
  icon.svg            favicon and app icon
  sheet.css|js        renderer for plain-text cheat sheets
  toolbox.css|js      tool shell and shared helpers (DT)
  tools/*.js          one file per tool; xsd-model.js, xsd-validate.js, xsd-sample.js, xsd-diagram.js are the XSD libraries behind xsd.js; nats-uci.js (schema-aware decoding), nats-charts.js (SVG charts), schema-panel.js and cal-owp.js back nats.js and cal.js; schema-diff-lib.js, uci-analysis.js, traffic-lab.js and world-map.js back the diff, lab and analyze views
  vendor/js-yaml.min.js
tests/                unit tests, catalog checks, .NET cross-checks, real-browser smoke test
  fixtures/zoo.xsd, unq.xsd   schemas that exercise features the UCI schema does not
```

## Adding a cheat sheet

Copy any of the newer sheets (for example `sheets/jq.html`) and edit the plain-text block:

```
title: jq
eyebrow: small caption above the title
lede: One or two sentences.
footer: Optional closing note.

== Section title | small tag
note: Optional intro, `inline code` allowed.
some command --flag ## What it does
|| Column A || Column B
|| value || meaning
```

- One row per line: `code ## description`. A table starts at the first `||` line (first row is the header).
- Use the `␤` symbol inside code to mean a line break in multi-line examples.
- Then add an entry to `catalog.js`. The catalog test fails if a file and its entry drift apart.

The first eight sheets (Git, GitHub CLI, GitLab CLI, Docker, kubectl, NATS, Go, C#) are standalone pages exported from the original artifacts, re-themed dark.

## Adding a tool

1. Create `assets/tools/<id>.js` that calls `DT.register({ id, name, group, desc, keywords, render(root) { ... } })`. Put anything worth testing on `DT.lib`.
2. Add a `<script>` line for it to `toolbox.html` and an entry to `catalog.js`.
3. Add a behaviour check in `tests/browser-smoke.js` (`TOOL_CHECKS`) and unit tests for the `DT.lib` functions.

### Bridge Compare (NATS vs CAL)

Connects to a NATS server and an LA-CAL at once and pairs the same UCI message arriving on both (matched by message name, header SystemID and Timestamp, and the identifiers in its body). It reports how long each took to cross (CAL receive time minus NATS receive time), messages seen on one side only after a pairing window, and, with the schema loaded, a field-by-field comparison of the NATS XML (converted to OMS JSON) with the CAL message.

### Replay controls and fault injection

The Traffic Lab's Replay tab plays at 0.25x to 10x or as fast as possible; the speed can be changed while playing. **Pause**, **Next invalid message** (jumps to the next message that failed validation; needs the schema) and a play range (from % to % of the recording) are available. **Fault injection** is off unless ticked: drop %, duplicate %, jitter and a reorder window, to see how a consumer copes; the result line reports what was injected. Use it against a test server only.

## Live test servers

`npm run smoke` always runs the mock-OWP checks. To also run the real-server checks (the NATS Explorer's tabs, the Traffic Lab's live source and replay faults), start a NATS server with JetStream, a system account and a WebSocket listener, and point the test at it:

```
# nats.conf
server_name: dt-test
port: 4222
jetstream { store_dir: "/data" }
system_account: SYS
accounts {
  SYS { users: [ { user: sys, password: sys } ] }
  APP { jetstream: enabled, users: [ { user: app, password: app } ] }
}
no_auth_user: app
websocket { port: 8080, no_tls: true, no_auth_user: app }
```

```
docker run -d --name dt-nats -p 18080:8080 -v ./nats.conf:/nats.conf:ro nats:latest -c /nats.conf
NATS_WS=ws://127.0.0.1:18080 npm run smoke
```

For the NKey checks run a second server whose only user is an NKey (generate a pair with `DT.lib.nkeyGenerate()` in the browser console, or in a Node script that loads `tests/harness.js`; put the public key in `authorization { users: [ { nkey: U... } ] }`) and add `NATS_NKEY_WS=ws://127.0.0.1:18081 NATS_NKEY_SEED=SU...`. `.creds` login needs an operator-mode server; its parsing and signing are covered by unit tests only.

## Tests

```
npm test            # 197 unit tests, Node 18+, no dependencies (UCI integration tests skip if the schema folder is absent)
npm run smoke       # drives headless Chrome/Edge through every page and tool, menus, and the XSD explorer on the real UCI files
                    # NATS_WS=ws://127.0.0.1:8080 npm run smoke also drives the NATS Explorer against a real JetStream-enabled nats-server
npm run crosscheck  # compares the XSD validator and sample generator with .NET on the UCI schema, the zoo schema and an unqualified-namespace schema
```

- The UCI folder defaults to `C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL`; override with `UCI_SCHEMA_DIR`. The browser binary can be overridden with `CHROME`.
- `crosscheck` needs Windows PowerShell (it runs `tests/dotnet-validate.ps1`). On the UCI release it generates a sample for all 725 messages in both modes (1,450 files, all accepted by .NET) plus thousands of seeded random mutations, and requires the same valid / invalid verdict as .NET every time. Add `--mutations N --seed S` to widen it.
- `node tests/browser-smoke.js --shots ./shots` also saves screenshots.

## Notes

- Everything runs locally. The entire site is 100% offline and self-contained with zero external CDN dependencies; system fonts and a local vendored Prism are used. The JWT, hash and password tools use the browser's Web Crypto; nothing is sent anywhere.
- The OMS, UCI and AMS GRA sheets summarize public open-arsenal documents and facts read from the release XSDs (Distribution A; "not intended for operational use"). Use official sources for anything operational.
- The CIDR calculator is IPv4 only. Cron supports standard 5-field (and 6-field with seconds) syntax, not Quartz `L`, `W`, `#`. Distance math uses a spherical Earth (mean radius 6371.0088 km): fine for planning, not for survey-grade work.
- Browsers cannot validate against an XSD natively; the in-page validator is this project's own implementation (see above for its limits).
