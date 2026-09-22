using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Batona.NativeCodexProbe
{
    // Polls the semantic UIA tree and turns Chromium's token-sized mutations into
    // stable assistant-message snapshots. This is an exploration tool, not the
    // production bridge protocol.
    internal static class StreamMirror
    {
        private const int PollIntervalMs = 80;

        private static int Main(string[] args)
        {
            int processId;
            int seconds;
            if (args.Length < 4 || !int.TryParse(args[0], out processId) || !int.TryParse(args[1], out seconds))
            {
                Console.Error.WriteLine("usage: native-codex-stream-mirror <process-id> <seconds> <task-title> <output-file>");
                return 2;
            }

            string expectedTask = DecodeArg(args[2]);
            Process process = Process.GetProcessById(processId);
            if (process.MainWindowHandle == IntPtr.Zero) return Fail("process-has-no-main-window", 3);
            AutomationElement root = AutomationElement.FromHandle(process.MainWindowHandle);
            string outputPath = Path.GetFullPath(args[3]);
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath));

            using (var writer = new StreamWriter(outputPath, false, new UTF8Encoding(false)))
            {
                writer.WriteLine("# timestamp\tevent\tturn\tstate\ttext\tdelta");
                AutomationElement document = FindDocument(root, expectedTask);
                if (document == null) return Fail("active-task-mismatch", 4);
                AutomationElement transcript = FindTranscript(document);
                if (transcript == null) return Fail("transcript-not-found", 5);
                Snapshot baseline = ReadLatest(transcript);

                int previousTurnCount = baseline.TurnCount;
                string previousText = baseline.Text;
                bool previousCompleted = baseline.Completed;
                int streamTurn = 0;
                Write(writer, "baseline", streamTurn, baseline, "");

                DateTime end = DateTime.UtcNow.AddSeconds(Math.Max(1, seconds));
                DateTime nextRefresh = DateTime.UtcNow;
                while (DateTime.UtcNow < end)
                {
                    Thread.Sleep(PollIntervalMs);
                    if (DateTime.UtcNow >= nextRefresh)
                    {
                        AutomationElement refreshedTranscript = FindTranscript(document);
                        if (refreshedTranscript != null) transcript = refreshedTranscript;
                        nextRefresh = DateTime.UtcNow.AddMilliseconds(300);
                    }
                    Snapshot current = ReadLatest(transcript);
                    if (!current.TaskMatched)
                    {
                        // React reconciliation may temporarily detach the transcript
                        // provider. Keep the last stable snapshot and reacquire the
                        // semantic container instead of emitting a false reset.
                        AutomationElement refreshedDocument = FindDocument(root, expectedTask);
                        AutomationElement refreshedTranscript = refreshedDocument == null ? null : FindTranscript(refreshedDocument);
                        if (refreshedTranscript != null) transcript = refreshedTranscript;
                        continue;
                    }

                    bool newTurn = current.TurnCount > previousTurnCount
                        || (previousCompleted && !current.Completed
                            && !string.Equals(current.Text, previousText, StringComparison.Ordinal));
                    if (newTurn)
                    {
                        streamTurn += 1;
                        previousTurnCount = current.TurnCount;
                        previousText = "";
                        previousCompleted = false;
                        Write(writer, "turn-start", streamTurn, current, "");
                    }
                    else previousTurnCount = current.TurnCount;

                    if (!string.Equals(current.Text, previousText, StringComparison.Ordinal))
                    {
                        string delta = current.Text.StartsWith(previousText, StringComparison.Ordinal)
                            ? current.Text.Substring(previousText.Length)
                            : "";
                        Write(writer, delta.Length > 0 ? "append" : "replace", streamTurn, current, delta);
                        previousText = current.Text;
                    }

                    if (current.Completed && !previousCompleted)
                    {
                        Write(writer, "complete", streamTurn, current, "");
                    }
                    previousCompleted = current.Completed;
                    writer.Flush();
                }
            }
            return 0;
        }

        private static Snapshot ReadLatest(AutomationElement transcript)
        {
            List<AutomationElement> labels = FindAssistantLabels(transcript);
            if (labels.Count == 0) return new Snapshot(true, 0, false, "");

            var text = new StringBuilder();
            bool afterLabel = false;
            bool completed = false;
            TreeWalker walker = TreeWalker.RawViewWalker;
            AutomationElement child = SafeFirstChild(walker, transcript);
            while (child != null)
            {
                if (SameElement(child, labels[labels.Count - 1]))
                {
                    afterLabel = true;
                    child = SafeNextSibling(walker, child);
                    continue;
                }
                if (afterLabel)
                {
                    if (ContainsButton(child, "复制"))
                    {
                        completed = true;
                        break;
                    }
                    AppendSemanticText(child, text);
                }
                child = SafeNextSibling(walker, child);
            }
            return new Snapshot(true, labels.Count, completed, Normalize(text.ToString()));
        }

        private static AutomationElement FindTranscript(AutomationElement document)
        {
            AutomationElement latest = null;
            try
            {
                Condition labelCondition = new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
                    new PropertyCondition(AutomationElement.NameProperty, "ChatGPT 说："));
                AutomationElementCollection matches = document.FindAll(TreeScope.Descendants, labelCondition);
                foreach (AutomationElement element in matches)
                {
                    if (IsAssistantLabel(element)) latest = element;
                }
            }
            catch { }
            if (latest == null)
            {
                foreach (AutomationElement element in Walk(document))
                {
                    if (IsAssistantLabel(element)) latest = element;
                }
            }
            return latest == null ? null : SafeParent(latest);
        }

        private static AutomationElement FindDocument(AutomationElement root, string expectedTask)
        {
            foreach (AutomationElement element in Walk(root))
            {
                try
                {
                    if (element.Current.ControlType == ControlType.Document
                        && string.Equals(element.Current.Name ?? "", expectedTask, StringComparison.Ordinal)) return element;
                }
                catch { }
            }
            return null;
        }

        private static List<AutomationElement> FindAssistantLabels(AutomationElement document)
        {
            var result = new List<AutomationElement>();
            TreeWalker walker = TreeWalker.RawViewWalker;
            AutomationElement element = SafeFirstChild(walker, document);
            while (element != null)
            {
                try
                {
                    if (IsAssistantLabel(element)) result.Add(element);
                }
                catch { }
                element = SafeNextSibling(walker, element);
            }
            return result;
        }

        private static bool IsAssistantLabel(AutomationElement element)
        {
            try
            {
                string className = element.Current.ClassName ?? "";
                return element.Current.ControlType == ControlType.Text
                    && string.Equals(element.Current.Name ?? "", "ChatGPT 说：", StringComparison.Ordinal)
                    && className.IndexOf("sr-only", StringComparison.Ordinal) >= 0;
            }
            catch { return false; }
        }

        private static void AppendSemanticText(AutomationElement root, StringBuilder output)
        {
            foreach (AutomationElement element in Walk(root))
            {
                try
                {
                    if (element.Current.ControlType != ControlType.Text) continue;
                    string className = element.Current.ClassName ?? "";
                    if (className.IndexOf("sr-only", StringComparison.Ordinal) >= 0) continue;
                    string name = element.Current.Name ?? "";
                    if (name.Length == 0 || name == "ChatGPT 说：") continue;
                    if (name.StartsWith("回复已开始", StringComparison.Ordinal)
                        || name.StartsWith("回复已完成：", StringComparison.Ordinal)) continue;
                    output.Append(name);
                }
                catch { }
            }
        }

        private static bool ContainsButton(AutomationElement root, string exactName)
        {
            foreach (AutomationElement element in Walk(root))
            {
                try
                {
                    if (element.Current.ControlType == ControlType.Button
                        && string.Equals(element.Current.Name ?? "", exactName, StringComparison.Ordinal)) return true;
                }
                catch { }
            }
            return false;
        }

        private static IEnumerable<AutomationElement> Walk(AutomationElement root)
        {
            var runtimeIds = new HashSet<string>(StringComparer.Ordinal);
            var stack = new Stack<AutomationElement>();
            stack.Push(root);
            TreeWalker walker = TreeWalker.RawViewWalker;
            while (stack.Count > 0 && runtimeIds.Count < 6000)
            {
                AutomationElement element = stack.Pop();
                string runtimeId;
                try { runtimeId = string.Join(".", Array.ConvertAll(element.GetRuntimeId(), delegate(int value) { return value.ToString(CultureInfo.InvariantCulture); })); }
                catch { continue; }
                if (!runtimeIds.Add(runtimeId)) continue;
                yield return element;

                var children = new List<AutomationElement>();
                AutomationElement child = SafeFirstChild(walker, element);
                while (child != null && children.Count < 6000)
                {
                    children.Add(child);
                    child = SafeNextSibling(walker, child);
                }
                for (int index = children.Count - 1; index >= 0; index -= 1) stack.Push(children[index]);
            }
        }

        private static AutomationElement SafeParent(AutomationElement element)
        {
            try { return TreeWalker.RawViewWalker.GetParent(element); } catch { return null; }
        }

        private static AutomationElement SafeFirstChild(TreeWalker walker, AutomationElement element)
        {
            try { return walker.GetFirstChild(element); } catch { return null; }
        }

        private static AutomationElement SafeNextSibling(TreeWalker walker, AutomationElement element)
        {
            try { return walker.GetNextSibling(element); } catch { return null; }
        }

        private static bool SameElement(AutomationElement left, AutomationElement right)
        {
            try
            {
                return string.Equals(
                    string.Join(".", Array.ConvertAll(left.GetRuntimeId(), delegate(int value) { return value.ToString(CultureInfo.InvariantCulture); })),
                    string.Join(".", Array.ConvertAll(right.GetRuntimeId(), delegate(int value) { return value.ToString(CultureInfo.InvariantCulture); })),
                    StringComparison.Ordinal);
            }
            catch { return false; }
        }

        private static string Normalize(string value)
        {
            return (value ?? "").Replace("\r\n", "\n").Replace("\r", "\n").Trim();
        }

        private static void Write(StreamWriter writer, string eventName, int streamTurn, Snapshot snapshot, string delta)
        {
            writer.WriteLine(string.Join("\t", new[]
            {
                DateTimeOffset.Now.ToString("o"), eventName,
                streamTurn.ToString(CultureInfo.InvariantCulture),
                snapshot.Completed ? "complete" : "streaming",
                Escape(snapshot.Text), Escape(delta)
            }));
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\t", "\\t").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        private static string DecodeArg(string value)
        {
            const string prefix = "base64:";
            if (!value.StartsWith(prefix, StringComparison.Ordinal)) return value;
            return Encoding.UTF8.GetString(Convert.FromBase64String(value.Substring(prefix.Length)));
        }

        private static int Fail(string message, int code)
        {
            Console.Error.WriteLine(message);
            return code;
        }

        private sealed class Snapshot
        {
            internal Snapshot(bool taskMatched, int turnCount, bool completed, string text)
            {
                TaskMatched = taskMatched;
                TurnCount = turnCount;
                Completed = completed;
                Text = text ?? "";
            }

            internal bool TaskMatched { get; private set; }
            internal int TurnCount { get; private set; }
            internal bool Completed { get; private set; }
            internal string Text { get; private set; }
        }
    }
}
