# Shared app-server transport probe

Experimental probes for shared `codex app-server` attachment, bidirectional
events, approval routing, and Batona's local bridge. Run from the repository root:

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
After the native handoff, use the `BATONA_SHARED_WS_URL` printed by `-Launch`
with `--attach`: it joins the existing listener without spawning another server
and performs the same read-only checks. The default is `ws://127.0.0.1:45678`;
if that port has an unverified listener, `-Launch` chooses a free loopback port
and prints the replacement URL. OS process inspection is still required to
confirm Desktop is one of that listener's clients. `--test-attach` exercises
this mode against a temporary server and cleans it up; it does not attach Desktop.
Add `--thread <thread-id>` to verify Batona's session-open endpoint subscribes
to that existing task's live notifications on the shared server. The probe
still blocks prompt/model/permission writes.

## 2026-09-23 findings

- The installed CLI offers `--listen ws://IP:PORT`, `app-server daemon`, and
  `app-server proxy`. In the live user profile, `app-server daemon version`
  could not connect to the default control socket.
- Before handoff, the running native ChatGPT/Codex Desktop process spawned `codex.exe app-server`
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
- After the coordinated restart, packaged Desktop PID `35016` held an
  established client connection to listener PID `26284` on `127.0.0.1:45678`;
  it had no private `codex.exe` child. The installed Batona PC still used its
  old, separate stdio process. The branch's Batona bridge joined the shared
  listener read-only and passed health, task, model, and profile checks.
- The unique native “运行测试” task was already loaded. A second connection's
  `thread/resume` subscribed in 17 ms with no active-writer conflict. A direct
  `turn/start` from that connection was accepted in 24 ms; it received three
  reply deltas and completion, and the persisted reply matched. The user
  confirmed both message and reply appeared in native Desktop. Total turn
  time was about 56 seconds during roughly 55 network reconnections, so it
  does not measure steady-state model latency.
- In the reverse direction, the user sent a short message from native
  Desktop while the second connection was subscribed. That connection saw
  `turn/started`, four reply deltas, and `turn/completed`. First delta arrived
  after about 81 seconds with two error events; the model/network phase still
  needs separate latency diagnosis. The Batona bridge now subscribes when
  its session-open endpoint is used in shared mode. Live Android delivery,
  approval ownership, and model/effort composer synchronization remain untested.
- A later isolated approval probe showed that both subscribed WebSocket clients
  receive the same approval request ID and both receive its resolution. The
  initiating client declined it; the temporary task was archived. On the
  designated native task, `turn/start` changed reasoning effort from `high` to
  `xhigh` and emitted `thread/settings/updated` in about 61 ms. A second turn
  restored `high`. A `thread/resume` model override on that already-loaded task
  did not change its model. The native composer label still needs human checking.
- The Batona HTTP bridge pilot submitted a text turn to that native task in
  about 159 ms and received reply deltas and completion through `/v1/events`;
  total turn time was about 4.2 s with a healthy model connection. The branch
  now has an explicit `BATONA_SHARED_CODEX_WRITES=1` opt-in for shared text
  turns and approval responses. It remains disabled by default, and the
  installed PC client has not been updated.
- After Desktop was fully closed and relaunched through `native-handoff.ps1
  -Launch`, the script reused listener PID `26284` and detected the new Desktop
  PID `40808` connected to it. A separate `-Status` check confirmed the same
  connection. Batona's read-only attach probe then passed health, task list,
  model and permission catalog checks, verified writes remained blocked, and
  subscribed to the designated native test task. This validates restart
  continuity for the currently installed Desktop version; a normal shortcut
  launch and a Codex upgrade still require separate checks.
- A post-restart one-shot Batona HTTP bridge pilot submitted text to that
  designated native test task in about 278 ms. The subscribed bridge received
  one user message, three assistant chunks, one final reply and turn completion;
  persisted history contained the expected reply after about 8.1 s. This is a
  local bridge test, not Android-to-gateway delivery or a visual Desktop check.

## Decision gate

Native attachment, bidirectional turn events, HTTP text submission, and
approval broadcast are proven on local probes. Source version 0.5.6 now routes
shared model+effort and fixed permission profile changes through
`thread/settings/update`, then waits for `thread/settings/updated`; shared writes
remain a local opt-in. The remaining gates are native composer visual
confirmation, permission profile behavior on a Desktop-owned task, actual
Android→gateway→PC delivery, and phone/Desktop approval race handling. These
new direct settings routes have not yet been exercised from the installed
Batona PC/Android pair. Production Gateway remains 0.3.2; gateway source is 0.3.3 and Android source is 0.3.7.

The following scripts require an explicit loopback URL and, for native turns,
the designated task UUID. They do not install or deploy Batona:

```powershell
node product/pc/tools/shared-transport-probe/request-route.cjs --attach ws://127.0.0.1:45678
node product/pc/tools/shared-transport-probe/live-turn.cjs --attach ws://127.0.0.1:45678 --thread <uuid> --effort high --mode restore
node product/pc/tools/shared-transport-probe/bridge-pilot.cjs --attach ws://127.0.0.1:45678 --thread <uuid>
```

The [handoff script](native-handoff.ps1) provides a read-only status check:

It uses the Windows PowerShell 5.1 included with Windows; PowerShell 7 is not required.

```powershell
powershell.exe -NoProfile -File product/pc/tools/shared-transport-probe/native-handoff.ps1 -Status
```

After saving work and quitting Codex Desktop, run `-Launch` from an external
PowerShell terminal. It reuses its recorded, healthy loopback app-server when
available, even if Desktop's PID has changed. Otherwise it starts a matching
CLI server, waits for `/readyz`, and starts packaged Desktop with
`CODEX_APP_SERVER_WS_URL` in **its process environment**. It waits for the new
Desktop process to establish a connection to that listener before reporting
success. It refuses to launch while Desktop is running and never terminates it.
It will not attach to an unknown listener; if the default port is occupied, it
selects a free loopback port instead. The ordinary Codex shortcut does not
inherit this temporary environment setting; use `-Launch` for each shared-mode
Desktop start. `-Stop` is only needed when
ending the experiment or replacing the server after a Codex update, and
requires Desktop to be closed. The script does not set persistent environment
variables.

The PC confirmation dialog uses `-Restart`: it checks the installed Desktop
process, requests a normal close, waits up to 15 seconds, then ends only the
same verified root process if it remains running. It verifies Desktop has exited
before using the shared server launch path. Save work before confirming.

```powershell
powershell.exe -NoProfile -File product/pc/tools/shared-transport-probe/native-handoff.ps1 -Launch
# After Desktop opens, from this repository root:
$sharedUrl = 'ws://127.0.0.1:45678' # replace with the BATONA_SHARED_WS_URL printed by -Launch
node product/pc/tools/shared-transport-probe/probe.cjs --attach $sharedUrl
# On the next Desktop restart, quit it and run -Launch again; the same verified
# listener is reused. When finished with the experiment, quit Desktop first:
powershell.exe -NoProfile -File product/pc/tools/shared-transport-probe/native-handoff.ps1 -Stop
```

For Batona's second connection, a newly built PC client must start with
`BATONA_SHARED_CODEX_WS_URL` set to the same URL. The current production build
remains on stdio until shared write and approval routing are validated. Do not set
`CODEX_APP_SERVER_FORCE_CLI=1` in Desktop's environment.

The WebSocket transport is described as experimental in the
[official app-server documentation](https://learn.chatgpt.com/docs/app-server).
Its listener has no Batona pairing gate; bind it only to loopback and never
forward its raw frames through the gateway. Re-check the internal Desktop
override on every Desktop update.
