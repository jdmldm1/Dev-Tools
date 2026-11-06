dev-tools

Offline, browser-only toolbox for UCI and OMS/AMS.

```bash
docker build -t dev-tools .
docker run --rm -p 9999:8080 dev-tools
```

If you want the browser NATS Explorer to use `nats://` addresses through the built-in `/nats-proxy`, run the container with a host-gateway mapping. This is especially useful on Linux when connecting to a NATS server on the host via `nats://host.docker.internal:4222`.

```bash
docker build -t dev-tools .
docker run --rm -p 9998:8080 \
  --add-host=host.docker.internal:host-gateway \
  dev-tools
```

Then open `http://localhost:9998/toolbox.html#nats` and connect to `nats://host.docker.internal:4222`.

 * UCI & Schemas: XSD explorer, schema diff, message builder.
 * Bus Telemetry: NATS & LA-CAL live feeds, JetStream, KV.
 * Traffic Lab: Replay, fault injection, bridge compare.
 * Dev Toolbox: Converters, regex, crypto, cheat sheets.
