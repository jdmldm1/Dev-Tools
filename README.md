# dev-tools

Dark-mode cheat sheets and browser-based developer tools. No build step, no server required, and nothing leaves the page.

Open `index.html`. Groups on the landing page and in the toolbox sidebar are collapsible (state is remembered); searching opens just the groups that match, and the toolbox sidebar also lists every cheat sheet.

## Cheat sheets (`sheets/`)

| Group | Sheets |
|-------|--------|
| CLI & DevOps | Git, GitHub CLI, GitLab CLI, Docker, kubectl, NATS |
| Shell & System | Linux & SSH, Bash, PowerShell, curl, jq, Vim |
| Languages & Data | Go, C#, Python, JavaScript / TypeScript, SQL, Regex |
| Web | HTTP, Markdown |
| XML & Mission Systems | XML / XPath / XSD, UCI · OMS · AMS GRA (repos, versions, and what the UCI 2.6 schema contains) |

Every sheet has a filter box, section chips and click-to-copy commands.

## Toolbox (`toolbox.html`)

| Group | Tools |
|-------|-------|
| Format & Validate | JSON formatter / validator (line + column errors), Regex tester (worker timeout guards against catastrophic backtracking), Text diff |
| Encode & Decode | Base64 (text + files), URL encode / decode / parse, Escape / unescape (HTML, XML, JSON, JS, regex, SQL, shell, CSV, Unicode) |
| Translate | JSON ⇄ YAML, CSV ⇄ JSON, JSON → code types (TypeScript, Go, C#, Python, Rust), curl → fetch / Python / PowerShell / Go / C# |
| Generate | UUID v4 / v7, ULID, random keys, password generator |
| Time & Numbers | Timestamp converter, Cron explainer (+ next runs), Number bases & bits, Color converter + WCAG contrast |
| Text | Case converter, Text utilities (sort, dedupe, number, join, split, replace, counts) |
| Network & Security | JWT decoder + HMAC verify, Hash & HMAC, chmod calculator, CIDR / subnet calculator |
| XML & Mission Systems | XML format / validate / convert, **XSD Schema Explorer & Validator**, Coordinates / distance / units, Bytes (hex dump, endianness, CRC) |

Deep link to a tool with `toolbox.html#jwt`, `toolbox.html#xsd`, etc.

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

## Layout

```
index.html            landing page (search + collapsible groups)
catalog.js            list of sheets and tools shown on the landing page and in the sidebar
toolbox.html          tool shell (collapsible sidebar + hash router)
sheets/*.html         one page per cheat sheet
assets/
  theme.css           shared dark theme       groups.js   collapsible groups with remembered state
  sheet.css|js        renderer for plain-text cheat sheets
  toolbox.css|js      tool shell and shared helpers (DT)
  tools/*.js          one file per tool; xsd-model.js, xsd-validate.js, xsd-sample.js, xsd-diagram.js are the XSD libraries behind xsd.js
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

## Tests

```
npm test            # 74 unit tests, Node 18+, no dependencies (UCI integration tests skip if the schema folder is absent)
npm run smoke       # drives headless Chrome/Edge through every page and tool, menus, and the XSD explorer on the real UCI files
npm run crosscheck  # compares the XSD validator and sample generator with .NET on the UCI schema, the zoo schema and an unqualified-namespace schema
```

- The UCI folder defaults to `C:/Users/JandL/Downloads/03_UCI-STD-002_Rev6_UCI_Schema_v2_6-CDRL`; override with `UCI_SCHEMA_DIR`. The browser binary can be overridden with `CHROME`.
- `crosscheck` needs Windows PowerShell (it runs `tests/dotnet-validate.ps1`). On the UCI release it generates a sample for all 725 messages in both modes (1,450 files, all accepted by .NET) plus thousands of seeded random mutations, and requires the same valid / invalid verdict as .NET every time. Add `--mutations N --seed S` to widen it.
- `node tests/browser-smoke.js --shots ./shots` also saves screenshots.

## Notes

- Everything runs locally. The JWT, hash and password tools use the browser's Web Crypto; nothing is sent anywhere.
- The eight original sheets load Google Fonts, and the C# sheet loads Prism from cdnjs; offline they fall back to system fonts (and C# loses syntax colouring). Everything else works fully offline.
- The UCI sheet records what the public open-arsenal repository pages state plus facts read from the release XSDs (Distribution A; "not intended for operational use"). Use official sources for anything operational.
- The CIDR calculator is IPv4 only. Cron supports standard 5-field (and 6-field with seconds) syntax, not Quartz `L`, `W`, `#`. Distance math uses a spherical Earth (mean radius 6371.0088 km): fine for planning, not for survey-grade work.
- Browsers cannot validate against an XSD natively; the in-page validator is this project's own implementation (see above for its limits).
