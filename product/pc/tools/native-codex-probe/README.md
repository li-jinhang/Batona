# Native Codex UI probe

Exploration tools for the Batona native UI bridge:

- `Program.cs` snapshots the Windows UI Automation tree without focusing or changing the app.
- `Watch.cs` records UI Automation text, structure and property events.
- `StreamMirror.cs` polls the semantic tree and emits normalized assistant-message snapshots, append deltas and completion events.
- `Identity.cs` emits only SHA-256 fingerprints of the active task title and its last user/assistant pair, plus the window handle and number of matching sidebar rows.
- `native-thread-binding.js` compares those fingerprints with one `thread id` from the read-only app-server. `verify-binding.cjs` runs that check locally.
- `Controller.cs` performs guarded operations against one exact task. It verifies the active document title before setting a draft or invoking a named button and never uses screen coordinates or the clipboard.
- `BoundSender.cs` and `Identity.cs` form the packaged sender. `build-control.cjs` compiles them to `product/pc/build/native-codex-bound-sender.exe`; `native-codex-control.js` verifies the installed Codex signature, binds a thread with read-only history, and invokes the sender.

None of the tools acquires an app-server writer.

Build with the .NET Framework compiler already included in Windows:

```powershell
$framework = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$refs = @(
  "/reference:$framework\WPF\UIAutomationClient.dll",
  "/reference:$framework\WPF\UIAutomationTypes.dll",
  "/reference:$framework\WPF\WindowsBase.dll"
)
& "$framework\csc.exe" /nologo /target:exe /out:native-codex-probe.exe $refs Program.cs
& "$framework\csc.exe" /nologo /target:exe /out:native-codex-watch.exe $refs Watch.cs
& "$framework\csc.exe" /nologo /target:exe /out:native-codex-controller.exe $refs Controller.cs
& "$framework\csc.exe" /nologo /target:exe /out:native-codex-stream-mirror.exe $refs StreamMirror.cs
& "$framework\csc.exe" /nologo /target:exe /out:native-codex-identity.exe $refs Identity.cs
```

Run it against the UI process ID and keep output outside the source tree:

```powershell
.\native-codex-probe.exe 12345 D:\temp\codex-uia-tree.tsv
```

Arguments containing Chinese text can be passed as UTF-8 Base64 with a `base64:` prefix. The controller and stream mirror decode that prefix before matching UI elements.

With the target task already open in Codex Desktop, verify one app-server thread ID without sending anything:

```powershell
node verify-binding.cjs <thread-id> <Codex-window-process-id> .\native-codex-identity.exe
```

The binding requires a unique title in the complete app-server thread list and exactly one matching sidebar row. The latest completed user message and assistant reply must match the native UI. Missing history, duplicate titles, a task switch or an incomplete reply fails closed. The returned binding is a momentary observation. The packaged sender rechecks the same window, task and message fingerprints in its write operation, then checks again immediately before invoking Send. A different desktop, process, window, title, draft or recent turn fails closed. Switching into full access requires confirmation in Codex Desktop and is not approved remotely.

The stream mirror writes tab-separated `baseline`, `turn-start`, `append`, `replace` and `complete` records. `append` is the normal streaming path. A `replace` record tells the caller to replace its temporary text and reconcile the completed turn with read-only app-server history.

Text sending is integrated into the PC bridge for verified Codex Desktop tasks. It refuses input while Windows is locked or on a secure desktop, and serializes Batona remote sends. The stream mirror and controller remain exploratory; model switching, approvals, questions, a visible remote-control indicator, multi-device input lease and Codex-version selector tests remain open.
