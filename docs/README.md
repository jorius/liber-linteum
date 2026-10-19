# Docs

Where to start, depending on what you need.

| You want | Read |
|---|---|
| **What** the app does and why | [`product-spec.md`](product-spec.md): requirements with IDs (`GV-04`, `SR-02`…), personas, decision log |
| **How** it is built | [`superpowers/specs/2026-10-12-architecture-design.md`](superpowers/specs/2026-10-12-architecture-design.md): start at §0 "As built" for where the code differs from the v1 design |
| The index, its SQLite database and how indexing works | [`architecture/index-and-database.md`](architecture/index-and-database.md) |
| One milestone in detail | its spec in [`superpowers/specs/`](superpowers/specs/) (`YYYY-MM-DD-<milestone>-design.md`); later sections hold the amendments, review findings and rulings |
| How a milestone was planned task by task | [`superpowers/plans/`](superpowers/plans/) |
| What a round delivered, its reviews, rulings to confirm and real-window checklists | [`handoff/`](handoff/): one per round, newest is `2026-10-15-m5b-feedback-handoff.md` |
| Visual references | [`design/`](design/) (palettes) and the clickable prototype in `../design/prototype/` |

## Milestones and their documents

| Milestone | Spec | Hand-off |
|---|---|---|
| M0 scaffold | — (architecture §10) | `handoff/2026-10-12-m0-scaffold-handoff.md` |
| M1a vault core, M1b app integration | `2026-10-12-m1a-…`, `2026-10-12-m1b-…` | `2026-10-12-m1a-…`, `2026-10-12-m1b-…` |
| M2a editor, M2b editor UX, M2c page extras | `2026-10-12-m2a-…`, `2026-10-13-m2b-…`, `2026-10-14-m2c-…` | same dates |
| M3a Global View, M3b relationships | `2026-10-14-m3a-…`, `2026-10-14-m3b-…` | same dates |
| M4 block moves; M4b feedback (parts 1–3) | `2026-10-14-m4-…`, `2026-10-14-m4b-feedback-…`, `2026-10-14-m4b-part2-…`, `2026-10-15-m4b-part3-…` (+ `-wide-elements-…`) | `2026-10-14-m4-…`, `2026-10-14-m4b-…`, `2026-10-15-m4b-part3-…` |
| M4c Scratchpad and single-file windows | `2026-10-14-m4c-scratchpad-design.md` | `2026-10-15-m4c-scratchpad-handoff.md` |
| M5 search | `2026-10-14-m5-search-design.md` | `2026-10-15-m5-search-handoff.md` |
| M5b third feedback round | `2026-10-15-m5b-feedback-design.md` | `2026-10-15-m5b-feedback-handoff.md` |
| M6 audio | `2026-10-14-m6-audio-design.md` (draft) | — |
| M7 Notion import, M8 packaging | — | — |

All of M0–M5b is merged on `main` (2026-10-18).
