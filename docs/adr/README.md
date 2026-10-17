# Architecture decision records

Short records of decisions that shape Keel, why they were made, and what they cost. One file per decision, numbered in order. A record is never rewritten after it's accepted: a later record supersedes it instead.

Statuses: **Proposed** (open for discussion), **Accepted**, **Superseded by NNNN**, **Rejected**.

| # | Decision | Status |
|---|---|---|
| [0001](0001-multi-device-sync.md) | Use Keel on several devices through a synced local replica of a hosted libSQL database | Accepted |
| [0002](0002-authentication-and-encryption.md) | Passkey login for the browser terminal and Goals (TOTP as fallback), encryption at rest for local data, an optional shell lock | Proposed |
| [0003](0003-consistency-across-devices.md) | Consistency across devices: guarded writes at the single primary now, CRDT-ready data for a later offline mode | Proposed |

To add one, copy the structure of the latest record, take the next number, and add it to this table.
