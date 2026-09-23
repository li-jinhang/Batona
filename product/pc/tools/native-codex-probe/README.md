# Native Codex UI probe

Exploration tools for the Batona native UI bridge:

- `Program.cs` snapshots the Windows UI Automation tree without focusing or changing the app.
- `Watch.cs` records UI Automation text, structure and property events.
- `StreamMirror.cs` polls the semantic tree and emits normalized assistant-message snapshots, append deltas and completion events.
- `Identity.cs` emits only SHA-256 fingerprints of the active task title and its last user/assistant pair, plus the window handle and number of matching sidebar rows.
- `native-thread-binding.js` compares those fingerprints with one `thread id` from the read-only app-server. `verify-binding.cjs` runs that check locally.
- `Controller.cs` performs guarded operations against one exact task. It verifies the active document title before setting a draft or invoking a named button and never uses screen coordinates or the clipboard.

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

The binding requires a unique title in the complete app-server thread list and exactly one matching sidebar row. The latest completed user message and assistant reply must match the native UI. Missing history, duplicate titles, a task switch or an incomplete reply fails closed. The returned binding is a momentary observation; any future write must rerun verification immediately before changing the UI and also recheck the same window and task within the native control operation. This probe does not persist a binding or enable remote sending.

The stream mirror writes tab-separated `baseline`, `turn-start`, `append`, `replace` and `complete` records. `append` is the normal streaming path. A `replace` record tells the caller to replace its temporary text and reconcile the completed turn with read-only app-server history.

These executables are probes. Production integration still needs signed-process verification, atomic identity enforcement at write time, one remote-input lease, selector/version self-tests and explicit refusal while Windows is locked or on a secure desktop.
