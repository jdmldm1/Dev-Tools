dev-tools

Offline, browser-only toolbox.

```bash
docker build -t dev-tools .
docker run --rm -p 9999:8080 dev-tools
```


```bash
docker build -t dev-tools .
docker run --rm -p 9998:8080 \
  --add-host=host.docker.internal:host-gateway \
  dev-tools
```

Note: host gateway is required for nats:\\ connections

Then open `http://localhost:9998/toolbox.html#nats` and connect to `nats://host.docker.internal:4222`.

 * UCI & Schemas: XSD explorer, schema diff, message builder.
 * Bus Telemetry: NATS & LA-CAL live feeds, JetStream, KV.
 * Traffic Lab: Replay, fault injection, bridge compare.
 * Dev Toolbox: Converters, regex, crypto, cheat sheets.
