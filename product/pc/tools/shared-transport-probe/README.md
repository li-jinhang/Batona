# Shared app-server transport probe

Throwaway experiment for one narrow question: can two independent clients attach to
one `codex app-server` process, write the same thread, and receive each other's
events? Run from the repository root:

```powershell
node product/pc/tools/shared-transport-probe/probe.cjs
```

The script starts an accessible local Codex CLI binary with a fresh `CODEX_HOME`
under ignored `output/.shared-transport-probe/` and a loopback WebSocket listener.
It creates a new thread, persists one inert item without calling a model, resumes
that thread from a second client, and changes the thread name from each client.
The script terminates its server. It leaves its isolated scratch directory for
inspection; it never connects to the user's native Desktop thread.

For a read-only integration check with the current login profile, run:

```powershell
node product/pc/tools/shared-transport-probe/probe.cjs --live-readonly
```

This starts a second WebSocket app-server, connects both the probe and the
Batona PC bridge to it, and checks Batona's `/healthz`, `/v1/sessions`,
`/v1/models`, and `/v1/profiles`. It does not resume any thread, submit a turn,
or attach the native Desktop. The listener and bridge stop when the script exits.

## 2026-09-23 findings

- The installed CLI offers `--listen ws://IP:PORT`, `app-server daemon`, and
  `app-server proxy`. In the live user profile, `app-server daemon version`
  could not connect to the default control socket.
- The running native ChatGPT/Codex Desktop process spawned `codex.exe app-server`
  with no `--listen` argument. The server did not own a TCP listener. Batona PC
  spawned a separate `codex.exe app-server` process. Thus Batona's current bridge
  has no published address for joining the Desktop-owned stdio connection.
- On the isolated WebSocket app-server, both clients resumed and wrote the same
  persisted thread. Both received `thread/name/updated` after each write. A
  brand-new thread with no rollout file was not resumable by the second client;
  the probe first persisted an inert item to establish the rollout.
- Read-only inspection of installed Desktop `26.915.4065.0` found a local-host
  startup branch that reads `CODEX_APP_SERVER_WS_URL`. When set, it selects a
  WebSocket app-server client instead of spawning its private stdio client,
  unless `CODEX_APP_SERVER_FORCE_CLI=1`. This is an internal, undocumented
  Desktop setting, not a stable public integration contract. The installed
  Desktop CLI and the accessible CLI copy used by Batona have equal SHA-256
  hashes. The Windows local-daemon branch is gated off, so the WebSocket
  override is the relevant candidate on this machine.
- With `-c features.code_mode_host=true app-server --listen
  ws://127.0.0.1:<port> --analytics-default-enabled`, the current login profile
  initialized successfully. The experimental Batona bridge WebSocket transport
  passed all four read-only HTTP checks. Its default remains stdio; the opt-in
  variable in source is `BATONA_SHARED_CODEX_WS_URL`. The currently installed
  Batona PC build does not yet include this branch's change. The opt-in mode
  blocks mutating HTTP requests and does not respond to app-server requests;
  native Desktop remains responsible for approvals during attachment testing.
- This proves the protocol's single-process shared-client behavior for metadata,
  plus a compatible Batona read path. It does not prove native Desktop
  attachment, streamed turns, approval routing, or composer model/effort
  synchronization. No request was sent to the live “运行测试” task.

## Decision gate

The next gate needs a coordinated native Desktop restart: it only reads the
WebSocket override at process startup, and the current process hosts this
Codex conversation. Keep the native task as sole writer until Desktop is
actually observed using the shared listener. Then, using only the designated
“运行测试” task, verify:

1. Desktop attaches to the loopback listener and opens the task without an
   active-writer error; Batona attaches to the same **process**, not merely
   another listener on the same profile.
2. A Desktop-originated turn appears on Batona's second connection as live
   notifications, and a Batona-originated turn appears in Desktop's UI.
3. Model/effort settings and approval requests have a defined owner and round
   trip correctly; no client silently declines the other client's request.
4. Only after these pass, route Desktop-originator writes through the shared
   protocol and remove the foreground UI Automation dependency in this mode.

For the handoff, start the shared server on `127.0.0.1` with the flags above,
launch Desktop with `CODEX_APP_SERVER_WS_URL` in **its process environment**,
and launch a newly built Batona PC with `BATONA_SHARED_CODEX_WS_URL` set to the
same URL. Do not set `CODEX_APP_SERVER_FORCE_CLI=1`. The packaged Desktop
launch/inheritance path has not been exercised yet, so these are conditions,
not a tested restart recipe. If Desktop fails to attach, quit it, restart
normally without the override, and stop the temporary shared server. Leave the
current production Batona build on its default stdio path until validation.

The WebSocket transport is described as experimental in the
[official app-server documentation](https://learn.chatgpt.com/docs/app-server).
Its listener has no Batona pairing gate; bind it only to loopback and never
forward its raw frames through the gateway. Re-check the internal Desktop
override on every Desktop update.
