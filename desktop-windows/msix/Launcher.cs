using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        var launcherName = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
        var argument = string.Equals(launcherName, "ReelRecorderLauncher", StringComparison.OrdinalIgnoreCase)
            ? "--open-recorder"
            : string.Equals(launcherName, "ReelNotetakerLauncher", StringComparison.OrdinalIgnoreCase)
                ? "--open-notetaker"
                : null;
        if (argument == null) return 2;

        var directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        var executable = Path.Combine(directory, "Reel.exe");
        if (!File.Exists(executable)) return 3;

        Process.Start(new ProcessStartInfo
        {
            FileName = executable,
            Arguments = argument,
            WorkingDirectory = directory,
            UseShellExecute = false
        });
        return 0;
    }
}
