using System;
using System.IO;
using System.Security.Cryptography;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Media.Editing;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;
using Windows.Storage;
using Windows.UI;

namespace ReelNative
{
    internal static class MediaTrimTests
    {
        private static int Main()
        {
            string directory = Path.Combine(Path.GetTempPath(), "reel-media-trim-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            string source = Path.Combine(directory, "source.mp4"), wave = Path.Combine(directory, "tone.wav");
            string output = Path.Combine(directory, "trimmed.mp4");
            try
            {
                WriteTone(wave, 4);
                var composition = new MediaComposition();
                composition.Clips.Add(MediaClip.CreateFromColor(Color.FromArgb(255, 30, 120, 220), TimeSpan.FromSeconds(4)));
                var waveFile = StorageFile.GetFileFromPathAsync(wave).AsTask().GetAwaiter().GetResult();
                composition.BackgroundAudioTracks.Add(BackgroundAudioTrack.CreateFromFileAsync(waveFile).AsTask().GetAwaiter().GetResult());
                Render(composition, source);

                byte[] before;
                using (var sha = SHA256.Create()) before = sha.ComputeHash(File.ReadAllBytes(source));
                double exportedDuration = MediaTrim.Export(source, 1.0, 3.0, output);
                byte[] after;
                using (var sha = SHA256.Create()) after = sha.ComputeHash(File.ReadAllBytes(source));
                Assert(File.Exists(source), "The source recording was removed.");
                Assert(Equal(before, after), "The source recording changed during export.");
                Assert(File.Exists(output) && new FileInfo(output).Length > 0, "The export is empty.");
                Assert(Math.Abs(exportedDuration - 2.0) <= 0.25, "The export duration is wrong.");
                Assert(AudioTrackCount(output) > 0, "The export lost its audio track.");

                string samePath = Path.Combine(directory, "source-copy.mp4");
                File.Copy(source, samePath);
                byte[] sameBefore;
                using (var sha = SHA256.Create()) sameBefore = sha.ComputeHash(File.ReadAllBytes(samePath));
                bool rejected = false;
                try { MediaTrim.Export(samePath, 0, 2, samePath); } catch (ArgumentException) { rejected = true; }
                Assert(rejected, "Exporting over the source was not rejected.");
                byte[] sameAfter;
                using (var sha = SHA256.Create()) sameAfter = sha.ComputeHash(File.ReadAllBytes(samePath));
                Assert(Equal(sameBefore, sameAfter), "Rejected export changed the source.");

                Console.WriteLine("Windows media trim export passed: 2.0s MP4 with audio; original unchanged.");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
            finally
            {
                try { Directory.Delete(directory, true); } catch { }
            }
        }

        private static void Render(MediaComposition composition, string path)
        {
            using (File.Create(path)) { }
            var file = StorageFile.GetFileFromPathAsync(path).AsTask().GetAwaiter().GetResult();
            var result = composition.RenderToFileAsync(file, MediaTrimmingPreference.Precise,
                MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Auto)).AsTask().GetAwaiter().GetResult();
            Assert(result == TranscodeFailureReason.None && new FileInfo(path).Length > 0, "Could not render the synthetic MP4.");
        }

        private static int AudioTrackCount(string path)
        {
            var file = StorageFile.GetFileFromPathAsync(path).AsTask().GetAwaiter().GetResult();
            return MediaClip.CreateFromFileAsync(file).AsTask().GetAwaiter().GetResult().EmbeddedAudioTracks.Count;
        }

        private static void WriteTone(string path, int seconds)
        {
            const int sampleRate = 48000, channels = 1, bits = 16;
            int samples = sampleRate * seconds, dataBytes = samples * channels * bits / 8;
            using (var stream = File.Create(path))
            using (var writer = new BinaryWriter(stream))
            {
                writer.Write(new[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F' }); writer.Write(36 + dataBytes);
                writer.Write(new[] { (byte)'W', (byte)'A', (byte)'V', (byte)'E', (byte)'f', (byte)'m', (byte)'t', (byte)' ' });
                writer.Write(16); writer.Write((short)1); writer.Write((short)channels); writer.Write(sampleRate);
                writer.Write(sampleRate * channels * bits / 8); writer.Write((short)(channels * bits / 8)); writer.Write((short)bits);
                writer.Write(new[] { (byte)'d', (byte)'a', (byte)'t', (byte)'a' }); writer.Write(dataBytes);
                for (int i = 0; i < samples; i++) writer.Write((short)(Math.Sin(2 * Math.PI * 440 * i / sampleRate) * 6000));
            }
        }

        private static bool Equal(byte[] left, byte[] right)
        {
            if (left.Length != right.Length) return false;
            int diff = 0;
            for (int i = 0; i < left.Length; i++) diff |= left[i] ^ right[i];
            return diff == 0;
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
    }
}
