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
- This proves the protocol's single-process shared-client behavior for metadata,
  not native Desktop attachment, streamed turns, approval routing, or composer
  model/effort synchronization. No request was sent to the live “运行测试” task.

## Decision gate

Keep native Desktop's thread as the sole writer until a supported Desktop
connection option is found. If it can use a shared listener, repeat the probe
with two subscribers to the same test task and verify cross-client turn events,
approval ownership, and Desktop UI state. Do not point a second app-server at
the Desktop-owned task: prior testing recorded a writer conflict in ADR 0003.
