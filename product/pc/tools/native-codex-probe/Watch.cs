using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Batona.NativeCodexProbe
{
    internal static class Watch
    {
        private static readonly object WriteLock = new object();
        private static TextWriter Writer;

        private static int Main(string[] args)
        {
            int processId;
            int seconds;
            if (args.Length < 3 || !int.TryParse(args[0], out processId) || !int.TryParse(args[1], out seconds))
            {
                Console.Error.WriteLine("usage: native-codex-watch <process-id> <seconds> <output-file>");
                return 2;
            }

            Process process = Process.GetProcessById(processId);
            AutomationElement root = AutomationElement.FromHandle(process.MainWindowHandle);
            string outputPath = Path.GetFullPath(args[2]);
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath));

            using (var output = new StreamWriter(outputPath, false, new UTF8Encoding(false)))
            {
                Writer = TextWriter.Synchronized(output);
                Write("watch-start", root, "");
                AutomationEventHandler textHandler = delegate(object sender, AutomationEventArgs eventArgs)
                {
                    Write("text-changed", sender as AutomationElement, eventArgs.EventId.ProgrammaticName);
                };
                StructureChangedEventHandler structureHandler = delegate(object sender, StructureChangedEventArgs eventArgs)
                {
                    Write("structure-changed", sender as AutomationElement, eventArgs.StructureChangeType.ToString());
                };
                AutomationPropertyChangedEventHandler propertyHandler = delegate(object sender, AutomationPropertyChangedEventArgs eventArgs)
                {
                    string value = eventArgs.NewValue == null ? "" : Convert.ToString(eventArgs.NewValue, CultureInfo.InvariantCulture);
                    Write("property-changed", sender as AutomationElement, eventArgs.Property.ProgrammaticName + "=" + value);
                };

                Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, root, TreeScope.Subtree, textHandler);
                Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, structureHandler);
                Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, propertyHandler,
                    AutomationElement.NameProperty, ValuePattern.ValueProperty, AutomationElement.IsOffscreenProperty);
                try
                {
                    Thread.Sleep(Math.Max(1, seconds) * 1000);
                }
                finally
                {
                    Automation.RemoveAutomationEventHandler(TextPattern.TextChangedEvent, root, textHandler);
                    Automation.RemoveStructureChangedEventHandler(root, structureHandler);
                    Automation.RemoveAutomationPropertyChangedEventHandler(root, propertyHandler);
                    Write("watch-stop", root, "");
                }
            }
            return 0;
        }

        private static void Write(string type, AutomationElement element, string detail)
        {
            lock (WriteLock)
            {
                string control = Safe(delegate { return element == null ? "" : element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); });
                string name = Safe(delegate { return element == null ? "" : element.Current.Name; });
                string value = Safe(delegate
                {
                    if (element == null) return "";
                    object pattern;
                    return element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) ? ((ValuePattern)pattern).Current.Value : "";
                });
                Writer.WriteLine(string.Join("\t", new[] { DateTimeOffset.Now.ToString("o"), type, Escape(control), Escape(name), Escape(value), Escape(detail) }));
                Writer.Flush();
            }
        }

        private static string Safe(Func<string> read)
        {
            try { return read() ?? ""; } catch { return "<unavailable>"; }
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\t", "\\t").Replace("\r", "\\r").Replace("\n", "\\n");
        }
    }
}
