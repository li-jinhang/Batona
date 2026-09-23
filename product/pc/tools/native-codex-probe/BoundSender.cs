using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
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

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);

        private static int Main(string[] args)
        {
            int processId;
            if (args.Length < 3 || !int.TryParse(args[1], out processId)
                || (args[0] != "inspect" && args[0] != "send"))
                return Fail("usage", 2);
            if (args[0] == "inspect" && args.Length != 3) return Fail("usage", 2);
            if (args[0] == "send" && args.Length != 9) return Fail("usage", 2);

            try
            {
                if (!InteractiveDesktop()) return Fail("native-desktop-unavailable", 3);
                Process process = Process.GetProcessById(processId);
                if (process.SessionId != Process.GetCurrentProcess().SessionId) return Fail("native-session-mismatch", 4);
                if (!IsCodexPackage(process.MainModule.FileName)) return Fail("native-process-unverified", 5);
                IntPtr windowHandle = process.MainWindowHandle;
                if (windowHandle == IntPtr.Zero) return Fail("native-window-missing", 6);
                if (args[0] == "send" && !string.Equals(windowHandle.ToInt64().ToString("x"), args[2], StringComparison.OrdinalIgnoreCase))
                    return Fail("native-window-changed", 7);

                string title = Decode(args[args[0] == "inspect" ? 2 : 3]);
                if (title.Length == 0) return Fail("native-task-title-missing", 8);
                AutomationElement root = AutomationElement.FromHandle(windowHandle);
                if (!OpenUniqueTask(root, title)) return Fail("native-task-ambiguous", 9);
                Identity.Evidence observed = null;
                for (int attempt = 0; attempt < 15; attempt++)
                {
                    observed = Identity.Capture(root, processId, windowHandle);
                    if (observed.HasUser && observed.HasAssistant && observed.AssistantComplete) break;
                    Thread.Sleep(150);
                }
                if (observed.Title != title || observed.SidebarMatches != 1)
                    return Fail("native-task-identity-mismatch", 10);

                if (args[0] == "inspect")
                {
                    Console.WriteLine(observed.ToJson());
                    return 0;
                }

                string expectedUserHash = args[4];
                string expectedAssistantHash = args[5];
                string message = Decode(args[6]);
                string expectedTitleHash = args[7];
                string profileId = args[8];
                if (message.Trim().Length == 0 || message.Length > 32000) return Fail("native-message-invalid", 11);
                if (!Matches(observed, expectedTitleHash, expectedUserHash, expectedAssistantHash))
                    return Fail("native-task-identity-mismatch", 10);
                if (!SetPermission(root, title, profileId)) return Fail("native-profile-unavailable", 18);

                List<AutomationElement> composers = Find(root, ControlType.Edit, "随心输入", false);
                if (composers.Count != 1) return Fail("native-composer-unavailable", 12);
                object valuePattern;
                if (!composers[0].TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern))
                    return Fail("native-composer-unavailable", 12);
                ValuePattern composer = (ValuePattern)valuePattern;
                string existing = (composer.Current.Value ?? "").Trim();
                if (existing.Length > 0 && existing != "随心输入" && existing != message.Trim())
                    return Fail("native-composer-has-draft", 13);

                if (existing != message.Trim()) composer.SetValue(message);
                if (!WaitDraft(composer, message))
                    return Fail("native-draft-not-confirmed", 14);

                // Recheck after entering the draft, immediately before invoking
                // Send. A task switch or new turn prevents the submission.
                if (!InteractiveDesktop() || process.MainWindowHandle != windowHandle)
                    return Fail("native-window-changed", 7);
                observed = Identity.Capture(root, processId, windowHandle);
                if (!Matches(observed, expectedTitleHash, expectedUserHash, expectedAssistantHash))
                    return Fail("native-task-identity-mismatch", 10);
                if (!WaitDraft(composer, message))
                    return Fail("native-draft-not-confirmed", 14);

                List<AutomationElement> sends = Find(root, ControlType.Button, "发送", false);
                if (sends.Count != 1) return Fail("native-send-unavailable", 15);
                object invokePattern;
                if (!sends[0].TryGetCurrentPattern(InvokePattern.Pattern, out invokePattern))
                    return Fail("native-send-unavailable", 15);
                ((InvokePattern)invokePattern).Invoke();

                string messageHash = Identity.Hash(message);
                for (int attempt = 0; attempt < 8; attempt++)
                {
                    Thread.Sleep(100);
                    if (!InteractiveDesktop() || process.MainWindowHandle != windowHandle) break;
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
                return Fail("native-control-failed:" + error.GetType().Name, 17);
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

        private static bool SetPermission(AutomationElement root, string title, string profileId)
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
            // Codex requires a user confirmation before switching to full
            // access. The remote sender never confirms that escalation.
            if (profileId == "full-access") return false;
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
                    CancelFullAccessDialog(root);
                    return false;
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

        private static List<AutomationElement> Find(AutomationElement root, ControlType type, string name, bool allowOffscreen)
        {
            var result = new List<AutomationElement>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var stack = new Stack<AutomationElement>();
            stack.Push(root);
            TreeWalker walker = TreeWalker.RawViewWalker;
            while (stack.Count > 0 && seen.Count < 6000)
            {
                AutomationElement element = stack.Pop();
                try
                {
                    string id = string.Join(".", Array.ConvertAll(element.GetRuntimeId(), delegate(int value) { return value.ToString(); }));
                    if (!seen.Add(id)) continue;
                    if (element.Current.ControlType == type && (name == null || element.Current.Name == name)
                        && (allowOffscreen || !element.Current.IsOffscreen)) result.Add(element);
                }
                catch { continue; }
                var children = new List<AutomationElement>();
                AutomationElement child = null;
                try { child = walker.GetFirstChild(element); } catch { }
                while (child != null && children.Count < 6000)
                {
                    children.Add(child);
                    try { child = walker.GetNextSibling(child); } catch { child = null; }
                }
                for (int index = children.Count - 1; index >= 0; index--) stack.Push(children[index]);
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
