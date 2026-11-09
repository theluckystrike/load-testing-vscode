# Changelog

## 0.1.0 (2026-11-09)

- First release.
- Load tests as small YAML or JSON files (`*.load.yaml`, `*.load.json`) with schema validation, problems with line numbers and key completion.
- Closed model (virtual users) and open model (requests per second), with ramps.
- Checks (status, latency, body text, JSONPath, header) and thresholds (p50 to p99, errors, checks, rps).
- Live dashboard with requests per second, latency percentiles, failures, status codes and a Stop button.
- JSON and HTML reports for every run, a compare of two runs and a run history.
- Imports from .http and .rest files, cURL, HAR, OpenAPI and Swagger, and JMeter plans.
- A demo API on your own computer to try it with no server of your own.
- Safety: a confirmation that names each new host, a limit on users and rate, and a host blocklist.
