using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Batona.NativeCodexProbe
{
    internal static class Controller
    {
        private static int Main(string[] args)
        {
            int processId;
            if (args.Length < 3 || !int.TryParse(args[0], out processId))
            {
                Console.Error.WriteLine("usage: native-codex-controller <process-id> <open-task|set-draft|prepare-draft|send-message|expand-model|select-model|invoke-button|invoke-menu-item> <value> [expected-task]");
                return 2;
            }

            Process process = Process.GetProcessById(processId);
            if (process.MainWindowHandle == IntPtr.Zero) return Fail("process-has-no-main-window", 3);
            AutomationElement root = AutomationElement.FromHandle(process.MainWindowHandle);
            EnsureWindowReady(root);
            WarmUpAccessibility(root);
            string operation = args[1];
            string value = DecodeArg(args[2]);

            if (operation == "open-task") return OpenTask(root, value);
            if (operation == "set-draft")
            {
                if (args.Length < 4) return Fail("set-draft-requires-expected-task", 2);
                return SetDraft(root, value, DecodeArg(args[3]));
            }
            if (operation == "prepare-draft")
            {
                if (args.Length < 4) return Fail("prepare-draft-requires-task", 2);
                string task = DecodeArg(args[3]);
                int opened = OpenTask(root, task);
                return opened == 0 ? SetDraft(root, value, task) : opened;
            }
            if (operation == "send-message")
            {
                if (args.Length < 4) return Fail("send-message-requires-task", 2);
                string task = DecodeArg(args[3]);
                int opened = OpenTask(root, task);
                if (opened != 0) return opened;
                int drafted = SetDraft(root, value, task);
                if (drafted != 0) return drafted;
                if (!InvokeUnique(root, ControlType.Button, "发送", false, null)) return Fail("send-button-not-unique", 10);
                Console.WriteLine("message-submitted length=" + value.Length);
                return 0;
            }
            if (operation == "expand-model")
            {
                string task = args.Length >= 4 ? DecodeArg(args[3]) : value;
                if (!WaitForActiveTask(root, task, 1000)) return Fail("active-task-mismatch", 6);
                return ExpandModel(root);
            }
            if (operation == "select-model")
            {
                if (args.Length < 4) return Fail("select-model-requires-task", 2);
                string task = DecodeArg(args[3]);
                if (!WaitForActiveTask(root, task, 1000)) return Fail("active-task-mismatch", 6);
                return SelectModel(root, value);
            }
            if (operation == "invoke-button")
            {
                if (args.Length >= 4 && !IsActiveTask(root, DecodeArg(args[3]))) return Fail("active-task-mismatch", 6);
                return InvokeUnique(root, ControlType.Button, value, false, null) ? 0 : 7;
            }
            if (operation == "invoke-menu-item")
            {
                if (args.Length >= 4 && !IsActiveTask(root, DecodeArg(args[3]))) return Fail("active-task-mismatch", 6);
                return InvokeUnique(root, ControlType.MenuItem, value, false, null) ? 0 : 12;
            }
            return Fail("unknown-operation", 2);
        }

        private static int OpenTask(AutomationElement root, string title)
        {
            if (WaitForActiveTask(root, title, 500))
            {
                Console.WriteLine("active-task=" + title);
                return 0;
            }
            if (!InvokeUnique(root, ControlType.Button, title, true, "sidebar-item"))
            {
                if (WaitForActiveTask(root, title, 500))
                {
                    Console.WriteLine("active-task=" + title);
                    return 0;
                }
                foreach (AutomationElement document in Find(root, ControlType.Document, null, true))
                {
                    string documentName = SafeName(document);
                    Console.Error.WriteLine("document=" + documentName + " length=" + documentName.Length + " expected-length=" + title.Length + " equal=" + string.Equals(documentName, title, StringComparison.Ordinal));
                }
                foreach (AutomationElement button in Find(root, ControlType.Button, title, true))
                {
                    string className;
                    try { className = button.Current.ClassName ?? ""; } catch { className = "<unavailable>"; }
                    Console.Error.WriteLine("candidate-class=" + className);
                }
                return Fail("task-button-not-unique", 4);
            }
            for (int attempt = 0; attempt < 30; attempt += 1)
            {
                Thread.Sleep(100);
                if (IsActiveTask(root, title))
                {
                    Console.WriteLine("active-task=" + title);
                    return 0;
                }
            }
            return Fail("task-open-not-confirmed", 5);
        }

        private static void EnsureWindowReady(AutomationElement root)
        {
            object pattern;
            if (!root.TryGetCurrentPattern(WindowPattern.Pattern, out pattern)) return;
            WindowPattern window = (WindowPattern)pattern;
            try
            {
                if (window.Current.WindowVisualState == WindowVisualState.Minimized)
                {
                    window.SetWindowVisualState(WindowVisualState.Normal);
                    Thread.Sleep(300);
                }
            }
            catch { }
        }

        private static void WarmUpAccessibility(AutomationElement root)
        {
            try
            {
                AutomationElement document = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                if (document == null) return;
                object pattern;
                if (document.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                {
                    ((TextPattern)pattern).DocumentRange.GetText(12000);
                    Thread.Sleep(100);
                }
            }
            catch { }
        }

        private static int SetDraft(AutomationElement root, string text, string expectedTask)
        {
            if (!WaitForActiveTask(root, expectedTask, 500)) return Fail("active-task-mismatch", 6);
            List<AutomationElement> edits = Find(root, ControlType.Edit, null, false);
            if (edits.Count != 1) return Fail("composer-not-unique:" + edits.Count, 7);
            object pattern;
            if (!edits[0].TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return Fail("composer-has-no-value-pattern", 8);
            ((ValuePattern)pattern).SetValue(text);
            Thread.Sleep(300);
            string actual = ((ValuePattern)pattern).Current.Value ?? "";
            if (actual.IndexOf(text, StringComparison.Ordinal) < 0) return Fail("draft-verification-failed", 9);
            Console.WriteLine("draft-set length=" + text.Length);
            return 0;
        }

        private static bool IsActiveTask(AutomationElement root, string expectedTitle)
        {
            // Chromium may populate descendant providers lazily on the first full walk.
            Find(root, ControlType.Document, null, true);
            List<AutomationElement> documents = Find(root, ControlType.Document, null, true);
            return documents.Exists(delegate(AutomationElement document)
            {
                return string.Equals(SafeName(document), expectedTitle, StringComparison.Ordinal);
            });
        }

        private static int ExpandModel(AutomationElement root)
        {
            List<AutomationElement> buttons = Find(root, ControlType.Button, null, false);
            buttons = buttons.FindAll(delegate(AutomationElement button)
            {
                try
                {
                    string name = button.Current.Name ?? "";
                    object pattern;
                    return name.IndexOf("GPT-", StringComparison.OrdinalIgnoreCase) >= 0
                        && button.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern);
                }
                catch { return false; }
            });
            if (buttons.Count != 1)
            {
                foreach (AutomationElement button in buttons) Console.Error.WriteLine("model-button=" + SafeName(button));
                return Fail("model-button-not-unique:" + buttons.Count, 11);
            }
            object expandPattern;
            buttons[0].TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expandPattern);
            ((ExpandCollapsePattern)expandPattern).Expand();
            Thread.Sleep(300);
            Console.WriteLine("model-menu-expanded current=" + SafeName(buttons[0]));
            return 0;
        }

        private static int SelectModel(AutomationElement root, string target)
        {
            if (Find(root, ControlType.RadioButton, target, false).Count == 0)
            {
                if (Find(root, ControlType.MenuItem, "选择模型", false).Count == 0)
                {
                    int expanded = ExpandModel(root);
                    if (expanded != 0) return expanded;
                }
                if (!InvokeUnique(root, ControlType.MenuItem, "选择模型", false, null)) return Fail("model-picker-entry-missing", 12);
                Thread.Sleep(300);
            }
            if (!InvokeUnique(root, ControlType.RadioButton, target, false, null)) return Fail("target-model-not-unique", 13);
            for (int attempt = 0; attempt < 20; attempt += 1)
            {
                Thread.Sleep(100);
                List<AutomationElement> buttons = Find(root, ControlType.Button, null, false);
                bool buttonConfirmed = buttons.Exists(delegate(AutomationElement button)
                {
                    string name = SafeName(button);
                    return name.StartsWith(target, StringComparison.Ordinal);
                });
                // Chromium marks the slider's accessible description offscreen even
                // while the model menu is visible. It remains the most reliable
                // post-selection signal because the composer button is renamed to
                // "选择强度" after a model is selected.
                List<AutomationElement> texts = Find(root, ControlType.Text, null, true);
                bool textConfirmed = texts.Exists(delegate(AutomationElement text)
                {
                    return SafeName(text).StartsWith(target + " ", StringComparison.Ordinal);
                });
                if (buttonConfirmed || textConfirmed)
                {
                    CollapseModelMenu(root);
                    Console.WriteLine("model-selected=" + target);
                    return 0;
                }
            }
            return Fail("model-selection-not-confirmed", 14);
        }

        private static void CollapseModelMenu(AutomationElement root)
        {
            foreach (AutomationElement button in Find(root, ControlType.Button, null, false))
            {
                object pattern;
                try
                {
                    if (!button.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) continue;
                    ExpandCollapsePattern expandable = (ExpandCollapsePattern)pattern;
                    if (expandable.Current.ExpandCollapseState == ExpandCollapseState.Expanded)
                    {
                        expandable.Collapse();
                        return;
                    }
                }
                catch { }
            }
        }

        private static bool WaitForActiveTask(AutomationElement root, string expectedTitle, int timeoutMs)
        {
            int attempts = Math.Max(1, timeoutMs / 100);
            for (int attempt = 0; attempt < attempts; attempt += 1)
            {
                if (IsActiveTask(root, expectedTitle)) return true;
                Thread.Sleep(100);
            }
            return false;
        }

        private static bool InvokeUnique(AutomationElement root, ControlType type, string name, bool allowOffscreen, string requiredClassSubstring)
        {
            List<AutomationElement> matches = Find(root, type, name, allowOffscreen);
            if (requiredClassSubstring != null)
            {
                matches = matches.FindAll(delegate(AutomationElement candidate)
                {
                    try { return (candidate.Current.ClassName ?? "").IndexOf(requiredClassSubstring, StringComparison.Ordinal) >= 0; }
                    catch { return false; }
                });
            }
            if (matches.Count != 1)
            {
                Console.Error.WriteLine("match-count=" + matches.Count);
                return false;
            }
            AutomationElement element = matches[0];
            object scrollPattern;
            if (element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out scrollPattern))
            {
                try { ((ScrollItemPattern)scrollPattern).ScrollIntoView(); } catch { }
            }
            object invokePattern;
            if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out invokePattern)) return false;
            ((InvokePattern)invokePattern).Invoke();
            return true;
        }

        private static List<AutomationElement> Find(AutomationElement root, ControlType type, string exactName, bool allowOffscreen)
        {
            var result = new List<AutomationElement>();
            var runtimeIds = new HashSet<string>(StringComparer.Ordinal);
            var stack = new Stack<AutomationElement>();
            stack.Push(root);
            TreeWalker walker = TreeWalker.RawViewWalker;
            while (stack.Count > 0 && runtimeIds.Count < 6000)
            {
                AutomationElement element = stack.Pop();
                try
                {
                    string runtimeId = string.Join(".", Array.ConvertAll(element.GetRuntimeId(), delegate(int value) { return value.ToString(); }));
                    if (!runtimeIds.Add(runtimeId)) continue;
                    bool typeMatches = element.Current.ControlType == type;
                    bool nameMatches = exactName == null || string.Equals(element.Current.Name ?? "", exactName, StringComparison.Ordinal);
                    if (typeMatches && nameMatches && (allowOffscreen || !element.Current.IsOffscreen)) result.Add(element);
                }
                catch { }

                var children = new List<AutomationElement>();
                AutomationElement child = null;
                try { child = walker.GetFirstChild(element); } catch { }
                while (child != null && children.Count < 6000)
                {
                    children.Add(child);
                    try { child = walker.GetNextSibling(child); } catch { child = null; }
                }
                for (int index = children.Count - 1; index >= 0; index -= 1) stack.Push(children[index]);
            }
            return result;
        }

        private static string SafeName(AutomationElement element)
        {
            try { return element.Current.Name ?? ""; } catch { return ""; }
        }

        private static int Fail(string message, int code)
        {
            Console.Error.WriteLine(message);
            return code;
        }

        private static string DecodeArg(string value)
        {
            const string prefix = "base64:";
            if (!value.StartsWith(prefix, StringComparison.Ordinal)) return value;
            return Encoding.UTF8.GetString(Convert.FromBase64String(value.Substring(prefix.Length)));
        }
    }
}
