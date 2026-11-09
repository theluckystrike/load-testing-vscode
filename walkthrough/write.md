# Write or import a test

A test is a small YAML file whose name ends in `.load.yaml`:

```yaml
name: Orders API
target: http://localhost:3000
request:
  method: GET
  url: /api/orders
checks:
  status: 200
phases:
  - { duration: 10s, vus: [1, 20] }
  - { duration: 30s, vus: 20 }
thresholds:
  - p95 < 300ms
  - errors < 1%
```

- `vus` is the number of virtual users. `[1, 20]` ramps from 1 to 20.
- Use `rate: 100` instead of `vus` to send 100 requests per second, however slow the server is.
- Right-click a `.http`, `.rest`, `.har`, `.jmx` or OpenAPI file and pick "Create Load Test from File".
- Select a `curl` command in any editor, or copy it, and run "Create Load Test from cURL".
