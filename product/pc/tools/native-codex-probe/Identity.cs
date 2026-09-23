using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Automation;

namespace Batona.NativeCodexProbe
{
    // Read-only identity evidence. No conversation text leaves this process.
    internal static class Identity
    {
        private static int Main(string[] args)
        {
            int processId;
            if (args.Length != 1 || !int.TryParse(args[0], out processId))
            {
                Console.Error.WriteLine("usage: native-codex-identity <process-id>");
                return 2;
            }
            try
            {
                Process process = Process.GetProcessById(processId);
                if (process.MainWindowHandle == IntPtr.Zero) return Fail("window-missing", 3);
                AutomationElement root = AutomationElement.FromHandle(process.MainWindowHandle);
                Evidence evidence = Capture(root, processId, process.MainWindowHandle);
                Console.WriteLine(evidence.ToJson());
                return 0;
            }
            catch (Exception error)
            {
                return Fail("identity-inspection-failed:" + error.GetType().Name, 6);
            }
        }

        internal static Evidence Capture(AutomationElement root, int processId, IntPtr windowHandle)
        {
                AutomationElement document = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                if (document == null) throw new InvalidOperationException("document-missing");
                List<AutomationElement> elements = Walk(document);
                string title = SafeName(document);
                if (title.Length == 0) throw new InvalidOperationException("task-title-missing");

                int sidebarMatches = 0;
                AutomationElement lastUser = null;
                AutomationElement lastAssistant = null;
                foreach (AutomationElement element in elements)
                {
                    try
                    {
                        string name = element.Current.Name ?? "";
                        string className = element.Current.ClassName ?? "";
                        ControlType type = element.Current.ControlType;
                        if (type == ControlType.Button && name == title
                            && className.IndexOf("sidebar-item", StringComparison.Ordinal) >= 0) sidebarMatches++;
                        if (type == ControlType.Text && className.IndexOf("sr-only", StringComparison.Ordinal) >= 0)
                        {
                            if (name == "你说：") lastUser = element;
                            if (name == "ChatGPT 说：") lastAssistant = element;
                        }
                    }
                    catch { }
                }

                string userText = ReadUser(lastUser);
                bool assistantComplete;
                string assistantText = ReadAssistant(lastAssistant, out assistantComplete);
                return new Evidence(processId, windowHandle, title, sidebarMatches, userText, assistantText, assistantComplete);
        }

        internal sealed class Evidence
        {
            internal readonly int ProcessId;
            internal readonly IntPtr WindowHandle;
            internal readonly string Title;
            internal readonly int SidebarMatches;
            internal readonly string LastUserHash;
            internal readonly string LastAssistantHash;
            internal readonly bool HasUser;
            internal readonly bool HasAssistant;
            internal readonly bool AssistantComplete;

            internal Evidence(int processId, IntPtr windowHandle, string title, int sidebarMatches,
                string lastUser, string lastAssistant, bool assistantComplete)
            {
                ProcessId = processId;
                WindowHandle = windowHandle;
                Title = title;
                SidebarMatches = sidebarMatches;
                LastUserHash = Hash(lastUser);
                LastAssistantHash = Hash(lastAssistant);
                HasUser = lastUser.Length > 0;
                HasAssistant = lastAssistant.Length > 0;
                AssistantComplete = assistantComplete;
            }

            internal string ToJson()
            {
                return "{\"processId\":" + ProcessId.ToString(CultureInfo.InvariantCulture)
                    + ",\"windowHandle\":\"" + WindowHandle.ToInt64().ToString("x", CultureInfo.InvariantCulture)
                    + "\",\"titleHash\":\"" + Hash(Title)
                    + "\",\"sidebarMatches\":" + SidebarMatches.ToString(CultureInfo.InvariantCulture)
                    + ",\"lastUserHash\":\"" + LastUserHash
                    + "\",\"lastAssistantHash\":\"" + LastAssistantHash
                    + "\",\"hasUser\":" + (HasUser ? "true" : "false")
                    + ",\"hasAssistant\":" + (HasAssistant ? "true" : "false")
                    + ",\"assistantComplete\":" + (AssistantComplete ? "true" : "false") + "}";
            }
        }

        private static string ReadUser(AutomationElement label)
        {
            AutomationElement parent = Parent(label);
            if (parent == null) return "";
            TreeWalker walker = TreeWalker.RawViewWalker;
            AutomationElement sibling = Next(walker, label);
            while (sibling != null)
            {
                if (IsLabel(sibling, "ChatGPT 说：") || IsLabel(sibling, "你说：")) break;
                if (SafeClass(sibling).IndexOf("bg-user-message", StringComparison.Ordinal) >= 0)
                    return SemanticText(sibling);
                sibling = Next(walker, sibling);
            }
            return "";
        }

        private static string ReadAssistant(AutomationElement label, out bool complete)
        {
            complete = false;
            AutomationElement parent = Parent(label);
            if (parent == null) return "";
            var text = new StringBuilder();
            TreeWalker walker = TreeWalker.RawViewWalker;
            AutomationElement sibling = Next(walker, label);
            while (sibling != null)
            {
                if (IsLabel(sibling, "ChatGPT 说：") || IsLabel(sibling, "你说：")) break;
                if (ContainsButton(sibling, "复制")) { complete = true; break; }
                // Current Codex Desktop renders normal assistant prose in these
                // semantic groups. Other content shapes fail identity matching.
                if (SafeClass(sibling).IndexOf("_Paragraph_", StringComparison.Ordinal) >= 0)
                    text.Append(SemanticText(sibling));
                sibling = Next(walker, sibling);
            }
            return Normalize(text.ToString());
        }

        private static bool ContainsButton(AutomationElement root, string name)
        {
            foreach (AutomationElement element in Walk(root))
            {
                try
                {
                    if (element.Current.ControlType == ControlType.Button
                        && string.Equals(element.Current.Name ?? "", name, StringComparison.Ordinal)) return true;
                }
                catch { }
            }
            return false;
        }

        private static string SemanticText(AutomationElement root)
        {
            var result = new StringBuilder();
            foreach (AutomationElement element in Walk(root))
            {
                try
                {
                    if (element.Current.ControlType != ControlType.Text) continue;
                    if ((element.Current.ClassName ?? "").IndexOf("sr-only", StringComparison.Ordinal) >= 0) continue;
                    string value = element.Current.Name ?? "";
                    if (value.StartsWith("回复已开始", StringComparison.Ordinal)
                        || value.StartsWith("回复已完成：", StringComparison.Ordinal)) continue;
                    result.Append(value);
                }
                catch { }
            }
            return Normalize(result.ToString());
        }

        private static List<AutomationElement> Walk(AutomationElement root)
        {
            var result = new List<AutomationElement>();
            if (root == null) return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var stack = new Stack<AutomationElement>();
            stack.Push(root);
            TreeWalker walker = TreeWalker.RawViewWalker;
            while (stack.Count > 0 && seen.Count < 6000)
            {
                AutomationElement element = stack.Pop();
                try
                {
                    string id = string.Join(".", Array.ConvertAll(element.GetRuntimeId(), delegate(int value) { return value.ToString(CultureInfo.InvariantCulture); }));
                    if (!seen.Add(id)) continue;
                    result.Add(element);
                }
                catch { continue; }
                var children = new List<AutomationElement>();
                AutomationElement child = First(walker, element);
                while (child != null && children.Count < 6000)
                {
                    children.Add(child);
                    child = Next(walker, child);
                }
                for (int index = children.Count - 1; index >= 0; index--) stack.Push(children[index]);
            }
            return result;
        }

        private static bool IsLabel(AutomationElement element, string name)
        {
            try
            {
                return element.Current.ControlType == ControlType.Text
                    && string.Equals(element.Current.Name ?? "", name, StringComparison.Ordinal)
                    && (element.Current.ClassName ?? "").IndexOf("sr-only", StringComparison.Ordinal) >= 0;
            }
            catch { return false; }
        }

        private static AutomationElement Parent(AutomationElement element)
        {
            try { return element == null ? null : TreeWalker.RawViewWalker.GetParent(element); } catch { return null; }
        }
        private static AutomationElement First(TreeWalker walker, AutomationElement element)
        {
            try { return walker.GetFirstChild(element); } catch { return null; }
        }
        private static AutomationElement Next(TreeWalker walker, AutomationElement element)
        {
            try { return walker.GetNextSibling(element); } catch { return null; }
        }
        private static string SafeName(AutomationElement element)
        {
            try { return element.Current.Name ?? ""; } catch { return ""; }
        }
        private static string SafeClass(AutomationElement element)
        {
            try { return element.Current.ClassName ?? ""; } catch { return ""; }
        }
        private static string Normalize(string value)
        {
            return (value ?? "").Replace("\r\n", "\n").Replace("\r", "\n").Trim();
        }
        internal static string Hash(string value)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(Normalize(value)));
                return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
            }
        }
        private static int Fail(string message, int code)
        {
            Console.Error.WriteLine(message);
            return code;
        }
    }
}
