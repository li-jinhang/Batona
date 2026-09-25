using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

namespace Batona.NativeCodexProbe
{
    // The app-server thread ID is verified by the Node binder. This process
    // rechecks its resulting fingerprints in the same operation that writes.
    internal static class BoundSender
    {
        private const uint DesktopReadObjects = 0x0001;
        private const int UoiName = 2;
        private static string modelFailure = "unknown";

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")]
        private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

        private static int Main(string[] args)
        {
            int processId;
            if (args.Length < 3 || !int.TryParse(args[1], out processId)
                || (args[0] != "inspect" && args[0] != "status" && args[0] != "send" && args[0] != "open-permission"
                    && args[0] != "close-permission" && args[0] != "set-permission" && args[0] != "set-model"))
                return Fail("usage", 2);
            if (args[0] == "inspect" && args.Length != 3) return Fail("usage", 2);
            if (args[0] == "status" && args.Length != 6) return Fail("usage", 2);
            if (args[0] == "send" && args.Length != 8) return Fail("usage", 2);
            if ((args[0] == "open-permission" || args[0] == "close-permission") && args.Length != 6) return Fail("usage", 2);
            if (args[0] == "set-permission" && (args.Length != 8
                || (args[7] != "confirmed" && args[7] != "unconfirmed"))) return Fail("usage", 2);
            if (args[0] == "set-model" && args.Length != 9) return Fail("usage", 2);

            string stage = "desktop-check";
            try
            {
                if (!InteractiveDesktop()) return Fail("native-desktop-unavailable", 3);
                stage = "process-lookup";
                Process process = Process.GetProcessById(processId);
                if (process.SessionId != Process.GetCurrentProcess().SessionId) return Fail("native-session-mismatch", 4);
                stage = "process-verify";
                if (!IsCodexPackage(process.MainModule.FileName)) return Fail("native-process-unverified", 5);
                stage = "window-lookup";
                IntPtr windowHandle = process.MainWindowHandle;
                if (windowHandle == IntPtr.Zero) return Fail("native-window-missing", 6);
                stage = "task-title-decode";
                string title = Decode(args[2]);
                if (title.Length == 0) return Fail("native-task-title-missing", 8);
                stage = "automation-root";
                AutomationElement root = AutomationElement.FromHandle(windowHandle);
                // Permission selection changes settings but sends no message.
                // The app-server binder already proved this title is unique;
                // require that exact task to be active without depending on
                // transcript accessibility nodes that may be missing or stale.
                if (args[0] == "set-permission")
                {
                    stage = "permission-task";
                    if (ActiveTitle(root) != title || Identity.Hash(title) != args[5])
                        return Fail("native-task-identity-mismatch", 10);
                    stage = "permission-set";
                    if (!SetPermission(root, title, args[6], args[7] == "confirmed"))
                        return Fail("native-profile-unavailable", 18);
                    Console.WriteLine("{\"profileId\":\"" + CurrentPermission(root) + "\"}");
                    return 0;
                }
                if (args[0] == "status")
                {
                    // Read only the active task's visible status. Never emit
                    // arbitrary UI text or change the selected task.
                    if (ActiveTitle(root) != title || Identity.Hash(title) != args[5])
                        return Fail("native-task-identity-mismatch", 10);
                    Console.WriteLine(ReadProgress(root));
                    return 0;
                }
                stage = "open-task";
                if (!OpenUniqueTask(root, title)) return Fail("native-task-ambiguous", 9);
                Identity.Evidence observed = null;
                for (int attempt = 0; attempt < 15; attempt++)
                {
                    stage = "capture-task-identity";
                    observed = Identity.Capture(root, processId, windowHandle);
                    if (observed.HasUser && observed.HasAssistant && observed.AssistantComplete) break;
                    Thread.Sleep(150);
                }
                stage = "verify-task-identity";
                if (observed.Title != title || observed.SidebarMatches != 1)
                    return Fail("native-task-identity-mismatch", 10);

                if (args[0] == "inspect")
                {
                    Console.WriteLine(observed.ToJson());
                    return 0;
                }

                string identityTitleHash = args[5];
                stage = "verify-bound-thread";
                if (!Matches(observed, identityTitleHash, args[3], args[4]))
                    return Fail("native-task-identity-mismatch", 10);
                if (args[0] == "open-permission" || args[0] == "close-permission")
                {
                    stage = "permission-menu";
                    if (!PermissionMenu(root, title, args[0] == "open-permission"))
                        return Fail("native-profile-unavailable", 18);
                    stage = "permission-read";
                    string currentPermission = CurrentPermission(root);
                    if (currentPermission.Length == 0) return Fail("native-profile-unavailable", 18);
                    Console.WriteLine("{\"profileId\":\"" + currentPermission + "\"}");
                    return 0;
                }
                if (args[0] == "set-model")
                {
                    stage = "model-arguments";
                    int effortIndex, effortCount;
                    if (!int.TryParse(args[7], out effortIndex) || !int.TryParse(args[8], out effortCount)
                        || effortIndex < 1 || effortIndex > effortCount || effortCount > 8)
                        return Fail("native-model-invalid", 19);
                    stage = "model-set";
                    if (!SetModel(root, title, windowHandle, Decode(args[6]), effortIndex, effortCount))
                        return Fail("native-model-unavailable:" + modelFailure, 20);
                    Console.WriteLine("{\"accepted\":true}");
                    return 0;
                }

                string expectedUserHash = args[3];
                string expectedAssistantHash = args[4];
                stage = "message-decode";
                string message = Decode(args[6]);
                string expectedTitleHash = args[5];
                string profileId = args[7];
                if (message.Trim().Length == 0 || message.Length > 32000) return Fail("native-message-invalid", 11);
                if (!Matches(observed, expectedTitleHash, expectedUserHash, expectedAssistantHash))
                    return Fail("native-task-identity-mismatch", 10);
                stage = "send-permission";
                if (profileId != "keep-current" && !SetPermission(root, title, profileId, false)) return Fail("native-profile-unavailable", 18);

                stage = "find-composer";
                List<AutomationElement> composers = Find(root, ControlType.Edit, "随心输入", false);
                if (composers.Count != 1) return Fail("native-composer-unavailable", 12);
                stage = "composer-pattern";
                object valuePattern;
                if (!composers[0].TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern))
                    return Fail("native-composer-unavailable", 12);
                ValuePattern composer = (ValuePattern)valuePattern;
                stage = "composer-read";
                string existing = (composer.Current.Value ?? "").Trim();
                if (existing.Length > 0 && existing != "随心输入" && existing != message.Trim())
                    return Fail("native-composer-has-draft", 13);

                stage = "composer-write";
                if (existing != message.Trim()) composer.SetValue(message);
                stage = "composer-confirm";
                if (!WaitDraft(composer, message))
                    return Fail("native-draft-not-confirmed", 14);

                // Recheck after entering the draft, immediately before invoking
                // Send. A task switch or new turn prevents the submission.
                if (!InteractiveDesktop() || process.MainWindowHandle != windowHandle)
                    return Fail("native-window-changed", 7);
                stage = "recheck-task-identity";
                observed = Identity.Capture(root, processId, windowHandle);
                if (!Matches(observed, expectedTitleHash, expectedUserHash, expectedAssistantHash))
                    return Fail("native-task-identity-mismatch", 10);
                stage = "recheck-composer";
                if (!WaitDraft(composer, message))
                    return Fail("native-draft-not-confirmed", 14);

                stage = "find-send-button";
                List<AutomationElement> sends = Find(root, ControlType.Button, "发送", false);
                if (sends.Count != 1) return Fail("native-send-unavailable", 15);
                stage = "send-button-pattern";
                object invokePattern;
                if (!sends[0].TryGetCurrentPattern(InvokePattern.Pattern, out invokePattern))
                    return Fail("native-send-unavailable", 15);
                stage = "invoke-send";
                ((InvokePattern)invokePattern).Invoke();

                string messageHash = Identity.Hash(message);
                for (int attempt = 0; attempt < 8; attempt++)
                {
                    Thread.Sleep(100);
                    if (!InteractiveDesktop() || process.MainWindowHandle != windowHandle) break;
                    stage = "confirm-submission";
                    Identity.Evidence after = Identity.Capture(root, processId, windowHandle);
                    if (after.Title == title && after.LastUserHash == messageHash)
                    {
                        Console.WriteLine("{\"accepted\":true}");
                        return 0;
                    }
                }
                return Fail("native-submit-unconfirmed", 16);
            }
            catch (Exception error)
            {
                return Fail("native-control-failed:" + stage + ":" + error.GetType().Name, 17);
            }
        }

        private static bool Matches(Identity.Evidence evidence, string titleHash, string userHash, string assistantHash)
        {
            return evidence.SidebarMatches == 1 && evidence.HasUser && evidence.HasAssistant && evidence.AssistantComplete
                && evidence.LastUserHash == userHash && evidence.LastAssistantHash == assistantHash
                && Identity.Hash(evidence.Title) == titleHash;
        }

        private static bool OpenUniqueTask(AutomationElement root, string title)
        {
            List<AutomationElement> matches = new List<AutomationElement>();
            for (int attempt = 0; attempt < 12; attempt++)
            {
                WarmUp(root);
                matches = Find(root, ControlType.Button, title, true).FindAll(delegate(AutomationElement element)
                {
                    try { return (element.Current.ClassName ?? "").IndexOf("sidebar-item", StringComparison.Ordinal) >= 0; }
                    catch { return false; }
                });
                if (matches.Count > 0) break;
                Thread.Sleep(100);
            }
            if (matches.Count != 1) return false;
            if (ActiveTitle(root) == title) return true;
            object invoke;
            if (!matches[0].TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) return false;
            ((InvokePattern)invoke).Invoke();
            for (int attempt = 0; attempt < 30; attempt++)
            {
                Thread.Sleep(100);
                if (ActiveTitle(root) == title) return true;
            }
            return false;
        }

        private static void WarmUp(AutomationElement root)
        {
            try
            {
                AutomationElement document = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                object pattern;
                if (document != null && document.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                    ((TextPattern)pattern).DocumentRange.GetText(12000);
            }
            catch { }
        }

        private static string CurrentPermission(AutomationElement root)
        {
            List<AutomationElement> buttons = Find(root, ControlType.Button, "更改权限", false);
            if (buttons.Count != 1) return "";
            if (PermissionIs(buttons[0], "请求批准")) return "request-approval";
            if (PermissionIs(buttons[0], "帮我批准")) return "assist-approval";
            if (PermissionIs(buttons[0], "完全访问")) return "full-access";
            return "";
        }

        private static bool PermissionMenu(AutomationElement root, string title, bool open)
        {
            if (ActiveTitle(root) != title) return false;
            List<AutomationElement> buttons = Find(root, ControlType.Button, "更改权限", false);
            if (buttons.Count != 1) return false;
            object pattern;
            if (!buttons[0].TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) return false;
            ExpandCollapsePattern menu = (ExpandCollapsePattern)pattern;
            if (open && menu.Current.ExpandCollapseState != ExpandCollapseState.Expanded) menu.Expand();
            if (!open && menu.Current.ExpandCollapseState == ExpandCollapseState.Expanded) menu.Collapse();
            if (ActiveTitle(root) != title) return false;
            if (!open) return true;
            for (int attempt = 0; attempt < 10; attempt++)
            {
                if (Find(root, ControlType.MenuItem, null, false).Exists(delegate(AutomationElement item)
                {
                    try { return (item.Current.Name ?? "").StartsWith("请求批准 ", StringComparison.Ordinal); }
                    catch { return false; }
                })) return true;
                Thread.Sleep(50);
            }
            return false;
        }

        private static AutomationElement ModelButton(AutomationElement root)
        {
            List<AutomationElement> buttons = Find(root, ControlType.Button, null, false).FindAll(delegate(AutomationElement button)
            {
                try
                {
                    object pattern;
                    string name = button.Current.Name ?? "";
                    return name != "添加文件等内容" && name != "更改权限"
                        && (button.Current.ClassName ?? "").IndexOf("h-token-button-composer", StringComparison.Ordinal) >= 0
                        && button.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern);
                }
                catch { return false; }
            });
            return buttons.Count == 1 ? buttons[0] : null;
        }

        private static bool SetModel(AutomationElement root, string title, IntPtr windowHandle,
            string displayName, int effortIndex, int effortCount)
        {
            modelFailure = "unknown";
            if (ActiveTitle(root) != title || displayName.Length == 0) return ModelFail("task");
            AutomationElement button = ModelButton(root);
            if (button == null) return ModelFail("button");
            object expandObject;
            if (!button.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expandObject)) return ModelFail("expand");
            ExpandCollapsePattern menu = (ExpandCollapsePattern)expandObject;
            if (menu.Current.ExpandCollapseState != ExpandCollapseState.Expanded) menu.Expand();

            List<AutomationElement> radios = Find(root, ControlType.RadioButton, null, false);
            if (radios.Count == 0)
            {
                List<AutomationElement> choices = new List<AutomationElement>();
                for (int attempt = 0; attempt < 30; attempt++)
                {
                    choices = Find(root, ControlType.MenuItem, "选择模型", false);
                    if (choices.Count == 1) break;
                    Thread.Sleep(100);
                }
                object invoke;
                if (choices.Count != 1 || !choices[0].TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) return ModelFail("picker");
                if (ActiveTitle(root) != title) return ModelFail("picker-task");
                ((InvokePattern)invoke).Invoke();
            }
            string normalizedName = NormalizeModelName(displayName);
            for (int attempt = 0; attempt < 40; attempt++)
            {
                Thread.Sleep(100);
                radios = Find(root, ControlType.RadioButton, null, false).FindAll(delegate(AutomationElement radio)
                {
                    try { return NormalizeModelName(radio.Current.Name ?? "") == normalizedName; }
                    catch { return false; }
                });
                if (radios.Count == 1) break;
            }
            object modelInvoke;
            if (radios.Count != 1 || !radios[0].TryGetCurrentPattern(InvokePattern.Pattern, out modelInvoke)) return ModelFail("choice");
            if (ActiveTitle(root) != title) return ModelFail("choice-task");
            ((InvokePattern)modelInvoke).Invoke();
            List<AutomationElement> strengthItems = new List<AutomationElement>();
            for (int attempt = 0; attempt < 30; attempt++)
            {
                Thread.Sleep(100);
                button = ModelButton(root);
                if (button == null || !button.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expandObject)) continue;
                try
                {
                    menu = (ExpandCollapsePattern)expandObject;
                    if (menu.Current.ExpandCollapseState == ExpandCollapseState.Expanded) menu.Collapse();
                    button = ModelButton(root);
                    if (button == null || !button.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expandObject)) continue;
                    menu = (ExpandCollapsePattern)expandObject;
                    if (menu.Current.ExpandCollapseState != ExpandCollapseState.Expanded) menu.Expand();
                    strengthItems = Find(root, ControlType.MenuItem, "强度", false);
                    if (strengthItems.Count == 1) break;
                }
                catch { }
            }
            if (strengthItems.Count != 1) return ModelFail("strength-menu");
            Thread.Sleep(300);
            int current, count;
            if (!ReadStrength(root, displayName, out current, out count)) return ModelFail("strength-read");
            if (count != effortCount) return ModelFail("strength-count");
            if (current != effortIndex)
            {
                strengthItems = Find(root, ControlType.MenuItem, "强度", false);
                if (strengthItems.Count != 1) return ModelFail("strength-item");
                SetForegroundWindow(windowHandle);
                strengthItems[0].SetFocus();
                Thread.Sleep(100);
                if (GetForegroundWindow() != windowHandle) return ModelFail("foreground");
                while (current != effortIndex)
                {
                    if (!InteractiveDesktop() || ActiveTitle(root) != title || GetForegroundWindow() != windowHandle)
                        return ModelFail("window-changed");
                    byte key = current < effortIndex ? (byte)0x27 : (byte)0x25;
                    keybd_event(key, 0, 0, UIntPtr.Zero);
                    keybd_event(key, 0, 2, UIntPtr.Zero);
                    int next = current < effortIndex ? current + 1 : current - 1;
                    bool moved = false;
                    for (int attempt = 0; attempt < 10; attempt++)
                    {
                        Thread.Sleep(50);
                        int observed, observedCount;
                        if (ReadStrength(root, displayName, out observed, out observedCount)
                            && observedCount == effortCount && observed == next)
                        { current = observed; moved = true; break; }
                    }
                    if (!moved) return ModelFail("strength-move");
                }
            }
            if (ActiveTitle(root) != title) return ModelFail("final-task");
            button = ModelButton(root);
            if (button != null && button.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expandObject))
            {
                menu = (ExpandCollapsePattern)expandObject;
                if (menu.Current.ExpandCollapseState == ExpandCollapseState.Expanded) menu.Collapse();
            }
            return true;
        }

        private static bool ModelFail(string stage)
        {
            modelFailure = stage;
            return false;
        }

        private static bool ReadStrength(AutomationElement root, string modelName, out int index, out int count)
        {
            index = 0; count = 0;
            string normalized = NormalizeModelName(modelName);
            foreach (AutomationElement status in Find(root, ControlType.StatusBar, null, false))
            {
                foreach (AutomationElement item in Find(status, ControlType.Text, null, true))
                {
                    string name;
                    try { name = item.Current.Name ?? ""; } catch { continue; }
                    if (!NormalizeModelName(name).StartsWith(normalized, StringComparison.Ordinal)) continue;
                    Match match = Regex.Match(name, @"第\s*(\d+)\s*项，共\s*(\d+)\s*项");
                    if (match.Success && int.TryParse(match.Groups[1].Value, out index)
                        && int.TryParse(match.Groups[2].Value, out count)) return true;
                }
            }
            return false;
        }

        private static string NormalizeModelName(string value)
        {
            return Regex.Replace(value ?? "", @"[\s\-]", "").ToUpperInvariant();
        }

        private static bool SetPermission(AutomationElement root, string title, string profileId, bool confirmedFullAccess)
        {
            string label;
            string menuPrefix;
            switch (profileId)
            {
                case "request-approval": label = "请求批准"; menuPrefix = "请求批准 "; break;
                case "assist-approval": label = "帮我批准"; menuPrefix = "帮我批准 "; break;
                case "full-access": label = "完全访问"; menuPrefix = "完全访问权限 "; break;
                default: return false;
            }
            List<AutomationElement> buttons = Find(root, ControlType.Button, "更改权限", false);
            if (buttons.Count != 1) return false;
            if (PermissionIs(buttons[0], label)) return true;
            if (profileId == "full-access" && !confirmedFullAccess) return false;
            object expand;
            if (!buttons[0].TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expand)) return false;
            ((ExpandCollapsePattern)expand).Expand();
            Thread.Sleep(150);
            List<AutomationElement> items = Find(root, ControlType.MenuItem, null, false).FindAll(delegate(AutomationElement item)
            {
                try { return (item.Current.Name ?? "").StartsWith(menuPrefix, StringComparison.Ordinal); }
                catch { return false; }
            });
            if (items.Count != 1) return false;
            if (ActiveTitle(root) != title) return false;
            object invoke;
            if (!items[0].TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) return false;
            ((InvokePattern)invoke).Invoke();
            for (int attempt = 0; attempt < 20; attempt++)
            {
                Thread.Sleep(100);
                if (Find(root, ControlType.Text, "要开启完整访问权限吗？", false).Count > 0)
                {
                    if (profileId != "full-access" || !confirmedFullAccess || ActiveTitle(root) != title)
                    {
                        CancelFullAccessDialog(root);
                        return false;
                    }
                    List<AutomationElement> confirm = Find(root, ControlType.Button, "确认", false);
                    object confirmInvoke;
                    if (confirm.Count != 1 || !confirm[0].TryGetCurrentPattern(InvokePattern.Pattern, out confirmInvoke))
                    {
                        CancelFullAccessDialog(root);
                        return false;
                    }
                    ((InvokePattern)confirmInvoke).Invoke();
                }
                buttons = Find(root, ControlType.Button, "更改权限", false);
                if (buttons.Count == 1 && PermissionIs(buttons[0], label)) return true;
            }
            return false;
        }

        private static void CancelFullAccessDialog(AutomationElement root)
        {
            List<AutomationElement> cancel = Find(root, ControlType.Button, "取消", false);
            if (cancel.Count != 1) return;
            object invoke;
            if (cancel[0].TryGetCurrentPattern(InvokePattern.Pattern, out invoke))
                ((InvokePattern)invoke).Invoke();
        }

        private static bool PermissionIs(AutomationElement button, string label)
        {
            return Find(button, ControlType.Text, label, false).Count == 1;
        }

        private static bool WaitDraft(ValuePattern composer, string message)
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    if (string.Equals((composer.Current.Value ?? "").Trim(), message.Trim(), StringComparison.Ordinal))
                        return true;
                }
                catch { return false; }
                Thread.Sleep(100);
            }
            return false;
        }

        private static string ActiveTitle(AutomationElement root)
        {
            try
            {
                AutomationElement doc = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                return doc == null ? "" : doc.Current.Name ?? "";
            }
            catch { return ""; }
        }

        private static string ReadProgress(AutomationElement root)
        {
            try
            {
                AutomationElement doc = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                if (doc == null) return "{\"state\":null}";
                foreach (AutomationElement element in Find(doc, ControlType.Text, null, false))
                {
                    string label = (element.Current.Name ?? "").Trim();
                    Match retry = Regex.Match(label,
                        @"^(?:正在重新连接|重新连接中|Reconnecting)\s*(?:[（(]?\s*(\d+)\s*/\s*(\d+)\s*[）)]?)?\s*[.…]*$",
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                    if (retry.Success)
                    {
                        int attempt, max;
                        if (int.TryParse(retry.Groups[1].Value, out attempt) && int.TryParse(retry.Groups[2].Value, out max)
                            && attempt > 0 && max > 0 && attempt <= max && max <= 100)
                            return "{\"state\":\"reconnecting\",\"attempt\":" + attempt + ",\"maxAttempts\":" + max + "}";
                        return "{\"state\":\"reconnecting\"}";
                    }
                    if (Regex.IsMatch(label, @"^(?:正在思考|思考中|Thinking)\s*[.…]*$",
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                        return "{\"state\":\"thinking\"}";
                }
            }
            catch { }
            return "{\"state\":null}";
        }

        private static List<AutomationElement> Find(AutomationElement root, ControlType type, string name, bool allowOffscreen)
        {
            var result = new List<AutomationElement>();
            Condition condition = name == null
                ? (Condition)new PropertyCondition(AutomationElement.ControlTypeProperty, type)
                : new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, type),
                    new PropertyCondition(AutomationElement.NameProperty, name));
            AutomationElementCollection matches = root.FindAll(TreeScope.Descendants, condition);
            foreach (AutomationElement element in matches)
            {
                try
                {
                    if (allowOffscreen || !element.Current.IsOffscreen) result.Add(element);
                }
                catch { }
            }
            return result;
        }

        private static bool IsCodexPackage(string filename)
        {
            string path = (filename ?? "").Replace('/', '\\').ToLowerInvariant();
            return path.Contains("\\windowsapps\\openai.codex_")
                && path.Contains("__2p2nqsd0c76g0\\app\\chatgpt.exe")
                && path.EndsWith("\\app\\chatgpt.exe", StringComparison.Ordinal);
        }

        private static bool InteractiveDesktop()
        {
            IntPtr desktop = OpenInputDesktop(0, false, DesktopReadObjects);
            if (desktop == IntPtr.Zero) return false;
            try
            {
                var name = new StringBuilder(256);
                int needed;
                return GetUserObjectInformation(desktop, UoiName, name, name.Capacity * 2, out needed)
                    && string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
            }
            finally { CloseDesktop(desktop); }
        }

        private static string Decode(string value)
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(value));
        }

        private static int Fail(string code, int exitCode)
        {
            Console.Error.WriteLine(code);
            return exitCode;
        }
    }
}
