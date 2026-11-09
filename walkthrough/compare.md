# Compare runs and set limits

"Compare Two Runs" puts two saved runs side by side: requests per second, p50 to p99, errors, and the latency curve. Green means the newer run is better.

Safety settings:

- `loadTesting.maxVirtualUsers` (default 200): a test that asks for more does not start.
- `loadTesting.blockedHosts` (default `*.gov`, `*.mil`): hosts that never receive load.
- Before the first run against a host, a dialog names the host and the load. Only test servers you own or may test.
