# Architecture decision records

| ADR                                            | Decision                                                    |
| ---------------------------------------------- | ----------------------------------------------------------- |
| [0001](0001-invocation-identity-isolation.md)  | Invocation identity is isolated, immutable, and fails closed |
| [0002](0002-versioned-canonical-model.md)      | Versioned canonical model with explicit usage semantics      |
| [0003](0003-provider-adapter-boundary.md)      | Provider payloads stop at the adapter boundary               |
| [0004](0004-stdout-and-fail-open.md)           | stdout belongs to the host; hooks fail open                  |
| [0005](0005-central-privacy-service.md)        | One central privacy service, content omitted by default      |
| [0006](0006-injected-state-and-telemetry.md)   | State, telemetry, clock, ids, and logging are injected       |
| [0007](0007-replay-stable-delivery-deduplication.md) | Replay-stable delivery deduplication, at most once     |

Related references: [usage semantics](../usage-semantics.md),
[registration evidence](../registration-evidence.md).
