using System;

namespace ReelNative
{
    internal static class MediaTrimProgram
    {
        private static int Main(string[] args)
        {
            if (args.Length != 4)
            {
                Console.Error.WriteLine("Usage: ReelMediaTrim.exe <source.mp4> <start-seconds> <end-seconds> <output.mp4>");
                return 2;
            }
            try
            {
                double duration = MediaTrim.Export(args[0], MediaTrim.ParseSeconds(args[1]), MediaTrim.ParseSeconds(args[2]), args[3]);
                Console.Out.WriteLine(duration.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
        }
    }
}
