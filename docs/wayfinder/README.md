# Wayfinder tracker (local markdown)

No issue tracker was configured for this repo, so wayfinder maps live here as
files. One directory per effort:

```
docs/wayfinder/<effort>/
  map.md                 the map — destination, notes, decisions, fog, out of scope
  tickets/NN-slug.md     one ticket per file, NN is its id
```

Refer to a map or ticket by its **title**, never by its number.

## Ticket frontmatter

```yaml
---
id: '03'
title: How the external quorum signs
type: grilling # research | prototype | grilling | task
status: open # open | closed
assignee: # empty means unclaimed
blocked_by: ['01'] # ids that must be closed first
---
```

## Wayfinding operations

**Load the map** — read `map.md` only. Do not read every ticket; zoom into one
when it becomes relevant.

**Find the frontier** — open, unblocked, unclaimed tickets:

```bash
grep -H -e "^id:" -e "^title:" -e "^type:" -e "^status:" -e "^assignee:" -e "^blocked_by:" docs/wayfinder/*/tickets/*.md
```

A ticket is on the frontier when `status: open`, `assignee:` is empty, and every
id in `blocked_by` belongs to a ticket with `status: closed`.

**Claim a ticket** — set `assignee:` to the dev or agent driving it, and save,
*before* doing any work. Concurrent sessions skip claimed tickets.

**Resolve a ticket** — append a `## Resolution` section to the ticket file, set
`status: closed`, then add one line to the map's *Decisions so far* linking the
ticket and gisting the answer. Detail stays in the ticket; the map only points.

**Rule a ticket out of scope** — set `status: closed`, append a `## Out of
scope` section saying why, and add one line to the map's *Out of scope*
section. It does not appear in *Decisions so far*.

**Add tickets** — create the files first, then wire `blocked_by` in a second
pass, since ids must exist before they can be referenced.

## Deviations from the wayfinder skill

- The skill resolves research tickets with a `/research` subagent on a
  throwaway `research/<name>` branch. There is no such skill installed here, so
  research tickets are resolved by a general-purpose subagent and its findings
  are written straight into the ticket's `## Resolution` section.
- Blocking has no native UI. The frontier is a grep, not a graph view.
