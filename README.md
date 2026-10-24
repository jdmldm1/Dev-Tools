# dev-tools

Dark-mode developer toolbox that runs entirely in your browser: nothing is uploaded anywhere.

```
docker build -t dev-tools .
docker run --rm -p 8080:8080 dev-tools        # http://localhost:8080
```

Or just open `index.html` (no build, no server). The image is ~1.2 MB.

## What's in it

- **XSD Schema Explorer** (opens by default): load a schema set (built against UCI 2.6); search messages, types and enums, view message diagrams, generate valid sample XML, and validate XML with line/column errors.
- **NATS Explorer**: connect over WebSocket; live feed with graphs (rates, busiest subjects, subject tree, plot any numeric field), publish and request/reply, and a read-only JetStream and KV browser. Any XML message is decoded against the loaded schema (any UCI version): documentation, enum meanings, header facts, schema validation with errors shown inline.
- **Schema Diff**: compare two schema versions (e.g. UCI 2.5 vs 2.6); each change rated breaking, review or additive, with the messages it reaches.
- **Message Builder**: compose a UCI message from a schema-generated form with live XML, OMS JSON and validation.
- **UCI Traffic Lab**: load a capture (or use the Analyze tab live): who is on the bus, command transactions, validity and latency, a map of tracks, and replay into NATS or a CAL.
- **CAL Explorer**: the same for an OMS Language-Agnostic CAL over the OMS WebSocket Protocol (topic + message subscriptions, live feed and graphs, publish with generated samples, OMS JSON decoded against any schema version).
- **Favorites**: star any tool or cheat sheet; stars sit at the top of the sidebar and overview.
- **Toolbox**: JSON, YAML, CSV, XML and curl converters, regex tester, diff, Base64, URL and escape tools, JWT, hashes and HMAC, UUID/ULID/password generator, timestamps, cron, number bases, colors, CIDR, chmod, coordinates and units, byte tools.
- **cheat sheets**: Git, GitHub and GitLab CLI, Docker, kubectl, NATS, Linux, Bash, PowerShell, curl, jq, Vim, Go, C#, Python, JavaScript/TypeScript, SQL, regex, HTTP, Markdown, XML/XPath/XSD, separate UCI, OMS and AMS GRA sheets.

`all.html` lists everything with search. Details, tests and layout: [DOCS.md](DOCS.md).
