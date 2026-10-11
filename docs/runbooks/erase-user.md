# User erasure (`yarn erase:user`): the token of an interrupted run

Every run prints `Database host: <host>` first: check it is the database you mean before you
pass `--apply`. `<id>` is the 32-character lowercase hex id from the `user` table.

## What can go wrong

`yarn erase:user … --apply` commits the erasure BEFORE it prints `Erased. Token erased:<uuid>.`
A run that is killed in between (a closed terminal, a lost connection, Ctrl-C) has erased the
user and shown no token. It may also have skipped the repair pass, which re-attributes rows
written with the user's id while the erasure ran.

## 1. Was it committed?

Run the same command again WITHOUT `--apply` (a dry run writes nothing).
`erase: no such user.` means the erasure was committed: go on to 2. Counts and
`Dry run: nothing changed.` mean it was not: nothing to recover, run the erasure again.

## 2. Read the token (read-only)

A committed erasure wrote one row to `deletion`: `kind = 'user'`, `subject` = the token,
`requested_by = 'cli:erase-user'`, `org_id` null, and `requested_at` = the start of the
erasure's transaction. Nothing in that row, or anywhere else, links the token to the person:
the row is found by its time alone.

```sql
select subject as token, requested_at
  from deletion
 where kind = 'user' and requested_by = 'cli:erase-user'
 order by requested_at desc
 limit 5;
```

The token is the `subject` of the row whose `requested_at` is the moment of the killed run
(the newest row, unless another erasure ran since). If two erasures ran so close together
that the time does not tell them apart, record both tokens for both requests.

## 3. Finish the repair pass

- Erased with `--user <id>`: `yarn erase:user --check --user <id>` reads how many rows still
  name the id and writes nothing. Then `yarn erase:user --finish <token> --user <id> --apply`
  re-attributes them; it is safe to run twice, and it prints `Finished. Token <token>.`
- Erased with `--email`: the id is kept nowhere after the erasure, so neither command can be
  run unless the id was noted before the run. The erasure itself is complete; only rows
  written with the id during the run could still carry it.
