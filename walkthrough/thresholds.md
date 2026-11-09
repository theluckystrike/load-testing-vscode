# Thresholds and reports

Each rule is checked live while the test runs and once more at the end:

| Rule | Meaning |
|---|---|
| `p95 < 300ms` | 95 % of requests finish in under 300 ms |
| `p99 <= 1s` | 99 % finish within 1 second |
| `errors < 1%` | under 1 % network errors, timeouts or 4xx/5xx responses |
| `checks > 99%` | over 99 % of the checks pass |
| `rps >= 200` | the average rate reaches 200 requests per second |

Every run is saved next to the test in `load-test-results/` as JSON and as an HTML report. The report has no script and loads nothing from the network, so you can attach it to a ticket.
