using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Media.Editing;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;
using Windows.Storage;

namespace ReelNative
{
    internal static class MediaTrim
    {
        internal static double Export(string sourcePath, double start, double end, string outputPath)
        {
            if (!File.Exists(sourcePath)) throw new InvalidOperationException("The source recording is unavailable.");
            if (!IsValidSeconds(start) || !IsValidSeconds(end) || end - start < 0.5)
                throw new ArgumentException("Choose a trim range of at least half a second.");

            string source = Path.GetFullPath(sourcePath), output = Path.GetFullPath(outputPath);
            if (String.Equals(source, output, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("The export must be a separate file from the original recording.");
            if (!String.Equals(Path.GetExtension(output), ".mp4", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Choose an MP4 export destination.");
            string directory = Path.GetDirectoryName(output);
            if (String.IsNullOrEmpty(directory) || !Directory.Exists(directory))
                throw new DirectoryNotFoundException("The export folder is unavailable.");

            string temporary = Path.Combine(directory, ".reel-trim-" + Guid.NewGuid().ToString("N") + ".mp4");
            try
            {
                using (File.Create(temporary)) { }
                var sourceFile = StorageFile.GetFileFromPathAsync(source).AsTask().GetAwaiter().GetResult();
                var clip = MediaClip.CreateFromFileAsync(sourceFile).AsTask().GetAwaiter().GetResult();
                double duration = clip.OriginalDuration.TotalSeconds;
                if (Double.IsNaN(duration) || Double.IsInfinity(duration) || start < 0 || start >= duration || end > duration + 0.25)
                    throw new ArgumentException("The selected trim range is outside the recording.");
                end = Math.Min(end, duration);
                if (end - start < 0.5) throw new ArgumentException("Choose a trim range of at least half a second.");

                clip.TrimTimeFromStart = TimeSpan.FromSeconds(start);
                clip.TrimTimeFromEnd = clip.OriginalDuration - TimeSpan.FromSeconds(end);
                var composition = new MediaComposition();
                composition.Clips.Add(clip);
                var outputFile = StorageFile.GetFileFromPathAsync(temporary).AsTask().GetAwaiter().GetResult();
                var result = composition.RenderToFileAsync(outputFile, MediaTrimmingPreference.Precise,
                    MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Auto)).AsTask().GetAwaiter().GetResult();
                if (result != TranscodeFailureReason.None || !File.Exists(temporary) || new FileInfo(temporary).Length == 0)
                    throw new InvalidOperationException("Windows could not render the trimmed recording.");

                var exported = MediaClip.CreateFromFileAsync(outputFile).AsTask().GetAwaiter().GetResult();
                double exportedDuration = exported.OriginalDuration.TotalSeconds;
                if (Double.IsNaN(exportedDuration) || Double.IsInfinity(exportedDuration)
                    || Math.Abs(exportedDuration - (end - start)) > 0.25)
                    throw new InvalidOperationException("The trimmed export has an unexpected duration.");

                if (File.Exists(output)) File.Replace(temporary, output, null);
                else File.Move(temporary, output);
                return exportedDuration;
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }

        private static bool IsValidSeconds(double value)
        {
            return !Double.IsNaN(value) && !Double.IsInfinity(value) && value >= 0
                && value <= TimeSpan.MaxValue.TotalSeconds;
        }

        internal static double ParseSeconds(string value)
        {
            double result;
            if (!Double.TryParse(value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out result)
                || !IsValidSeconds(result)) throw new ArgumentException("Trim times must be finite non-negative seconds.");
            return result;
        }
    }
}
