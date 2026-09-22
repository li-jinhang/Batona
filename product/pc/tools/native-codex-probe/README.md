# Native Codex UI probe

Exploration tools for the Batona native UI bridge:

- `Program.cs` snapshots the Windows UI Automation tree without focusing or changing the app.
- `Watch.cs` records UI Automation text, structure and property events.
- `StreamMirror.cs` polls the semantic tree and emits normalized assistant-message snapshots, append deltas and completion events.
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
```

Run it against the UI process ID and keep output outside the source tree:

```powershell
.\native-codex-probe.exe 12345 D:\temp\codex-uia-tree.tsv
```

Arguments containing Chinese text can be passed as UTF-8 Base64 with a `base64:` prefix. The controller and stream mirror decode that prefix before matching UI elements.

The stream mirror writes tab-separated `baseline`, `turn-start`, `append`, `replace` and `complete` records. `append` is the normal streaming path. A `replace` record tells the caller to replace its temporary text and reconcile the completed turn with read-only app-server history.

These executables are probes. Production integration still needs signed-process verification, a thread-ID-to-window identity binding, one remote-input lease, selector/version self-tests and explicit refusal while Windows is locked or on a secure desktop.
