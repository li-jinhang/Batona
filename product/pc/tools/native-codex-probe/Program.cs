using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Automation;

namespace Batona.NativeCodexProbe
{
    internal static class Program
    {
        private const int MaxElements = 6000;

        private static int Main(string[] args)
        {
            int processId;
            if (args.Length < 1 || !int.TryParse(args[0], out processId))
            {
                Console.Error.WriteLine("usage: native-codex-probe <process-id> [output-file]");
                return 2;
            }

            Process process;
            try
            {
                process = Process.GetProcessById(processId);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("process-not-found: " + error.Message);
                return 3;
            }

            if (process.MainWindowHandle == IntPtr.Zero)
            {
                Console.Error.WriteLine("process-has-no-main-window");
                return 4;
            }

            AutomationElement root;
            try
            {
                root = AutomationElement.FromHandle(process.MainWindowHandle);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("uia-root-failed: " + error.Message);
                return 5;
            }

            TextWriter writer = Console.Out;
            StreamWriter fileWriter = null;
            try
            {
                if (args.Length >= 2)
                {
                    string outputPath = Path.GetFullPath(args[1]);
                    Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
                    fileWriter = new StreamWriter(outputPath, false, new UTF8Encoding(false));
                    writer = fileWriter;
                }

                writer.WriteLine("# pid=" + processId.ToString(CultureInfo.InvariantCulture));
                writer.WriteLine("# window=" + Escape(SafeString(delegate { return root.Current.Name; })));
                writer.WriteLine("# columns=depth\tcontrolType\tname\tautomationId\tclassName\tfocusable\toffscreen\tpatterns\tbounds\tvalue\ttext");

                int count = 0;
                var runtimeIds = new HashSet<string>(StringComparer.Ordinal);
                var stack = new Stack<Node>();
                stack.Push(new Node(root, 0));
                TreeWalker walker = TreeWalker.RawViewWalker;

                while (stack.Count > 0 && count < MaxElements)
                {
                    Node node = stack.Pop();
                    AutomationElement element = node.Element;
                    string runtimeId;
                    try { runtimeId = string.Join(".", Array.ConvertAll(element.GetRuntimeId(), delegate(int value) { return value.ToString(); })); }
                    catch { runtimeId = "fallback-" + count.ToString(CultureInfo.InvariantCulture); }
                    if (!runtimeIds.Add(runtimeId)) continue;
                    writer.WriteLine(Describe(element, node.Depth));
                    count += 1;

                    var children = new List<AutomationElement>();
                    AutomationElement child = null;
                    try { child = walker.GetFirstChild(element); } catch { }
                    while (child != null && children.Count < MaxElements)
                    {
                        children.Add(child);
                        try { child = walker.GetNextSibling(child); } catch { child = null; }
                    }
                    for (int index = children.Count - 1; index >= 0; index -= 1)
                    {
                        stack.Push(new Node(children[index], node.Depth + 1));
                    }
                }

                writer.WriteLine("# count=" + count.ToString(CultureInfo.InvariantCulture));
                if (count >= MaxElements) writer.WriteLine("# truncated=true");
                return 0;
            }
            finally
            {
                if (fileWriter != null) fileWriter.Dispose();
            }
        }

        private static string Describe(AutomationElement element, int depth)
        {
            string controlType = SafeString(delegate
            {
                ControlType value = element.Current.ControlType;
                return value == null ? "" : value.ProgrammaticName.Replace("ControlType.", "");
            });
            string name = SafeString(delegate { return element.Current.Name; });
            string automationId = SafeString(delegate { return element.Current.AutomationId; });
            string className = SafeString(delegate { return element.Current.ClassName; });
            string focusable = SafeString(delegate { return element.Current.IsKeyboardFocusable ? "true" : "false"; });
            string offscreen = SafeString(delegate { return element.Current.IsOffscreen ? "true" : "false"; });
            string patterns = SafeString(delegate
            {
                AutomationPattern[] values = element.GetSupportedPatterns();
                var names = new List<string>();
                foreach (AutomationPattern value in values) names.Add(value.ProgrammaticName.Replace("PatternIdentifiers.Pattern", ""));
                return string.Join(",", names.ToArray());
            });
            string bounds = SafeString(delegate
            {
                Rect value = element.Current.BoundingRectangle;
                return string.Format(CultureInfo.InvariantCulture, "{0:0},{1:0},{2:0},{3:0}", value.X, value.Y, value.Width, value.Height);
            });
            string valueText = SafeString(delegate
            {
                object valuePattern;
                if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern)) return "";
                return ((ValuePattern)valuePattern).Current.Value;
            });
            string documentText = SafeString(delegate
            {
                object textPattern;
                if (!element.TryGetCurrentPattern(TextPattern.Pattern, out textPattern)) return "";
                return ((TextPattern)textPattern).DocumentRange.GetText(12000);
            });

            return string.Join("\t", new[]
            {
                depth.ToString(CultureInfo.InvariantCulture), Escape(controlType), Escape(name), Escape(automationId),
                Escape(className), Escape(focusable), Escape(offscreen), Escape(patterns), Escape(bounds),
                Escape(valueText), Escape(documentText)
            });
        }

        private static string SafeString(Func<string> read)
        {
            try { return read() ?? ""; }
            catch { return "<unavailable>"; }
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\t", "\\t").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        private sealed class Node
        {
            internal Node(AutomationElement element, int depth)
            {
                Element = element;
                Depth = depth;
            }

            internal AutomationElement Element { get; private set; }
            internal int Depth { get; private set; }
        }
    }
}
