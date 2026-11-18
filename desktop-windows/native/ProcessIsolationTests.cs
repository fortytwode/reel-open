using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using ReelNative;

internal static class ProcessIsolationTests
{
    private static string Quoted(string value) { return "\"" + value + "\""; }

    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--child")
        {
            if (Console.In.Read() != -1) return 2;
            Console.Out.WriteLine(new string('o', 131072));
            Console.Error.WriteLine(new string('e', 131072));
            Console.Out.WriteLine("{\"v\":1,\"id\":\"fake_child_frame\"}");
            File.WriteAllText(args[1], "done");
            return 0;
        }
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        if (args.Length == 2 && args[0] == "--wrapper")
        {
            string command = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            for (int i = 0; i < 32; i++)
                if (!NativeWindows.StartBrowserProcess(command, "/d /c exit 0")) return 5;
            if (!NativeWindows.StartBrowserProcess(executable, "--child " + Quoted(args[1]))) return 3;
            DateTime deadline = DateTime.UtcNow.AddSeconds(10);
            while (!File.Exists(args[1]) && DateTime.UtcNow < deadline) Thread.Sleep(20);
            if (!File.Exists(args[1])) return 4;
            Console.Out.WriteLine("wrapper complete");
            return 0;
        }
        // Keep camera-free support exact: a camera warning must not turn arbitrary
        // labels or a different action into a recognized Join control.
        if (!ChromeControls.Prefix("join now", "join now") ||
            !ChromeControls.Prefix("join now (Ctrl+Enter)", "join now") ||
            !ChromeControls.Prefix("join now without camera", "join now", "ask to join", "join meeting") ||
            ChromeControls.Prefix("join now camera blocked", "join now") ||
            ChromeControls.Prefix("join now camera not found", "join now") ||
            ChromeControls.Prefix("join now without camera settings", "join now") ||
            ChromeControls.Prefix("join now without camera", "turn off camera"))
            throw new Exception("Join warning label matching broadened beyond the exact allowed action.");
        string marker = Path.Combine(Path.GetTempPath(), "reel-process-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var wrapper = new Process())
            {
                wrapper.StartInfo = new ProcessStartInfo(executable, "--wrapper " + Quoted(marker)) {
                    UseShellExecute = false, RedirectStandardInput = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    CreateNoWindow = true
                };
                wrapper.Start();
                // Keep the wrapper's stdin open to prove the launched child
                // receives its own EOF instead of consuming protocol input.
                var stdout = wrapper.StandardOutput.ReadToEndAsync();
                var stderr = wrapper.StandardError.ReadToEndAsync();
                if (!wrapper.WaitForExit(15000)) { wrapper.Kill(); throw new Exception("Child streams were not drained."); }
                if (wrapper.ExitCode != 0 || stdout.Result != "wrapper complete" + Environment.NewLine || stderr.Result != "")
                    throw new Exception("Child output reached the parent protocol or launch failed.");
            }
            Console.WriteLine("PASS browser child stdin isolation, stdout/stderr drains and fast exits");
            return 0;
        }
        finally { if (File.Exists(marker)) File.Delete(marker); }
    }
}
