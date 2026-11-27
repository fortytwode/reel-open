using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ReelNative
{
    internal static class ClickSamplingTests
    {
        private const uint INPUT_MOUSE = 0;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const int SM_SWAPBUTTON = 23;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

        [StructLayout(LayoutKind.Sequential)]
        private struct MouseInput
        {
            public int X; public int Y; public uint MouseData; public uint Flags; public uint Time; public UIntPtr ExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeInput { public uint Type; public MouseInput Mouse; }
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(NativePoint point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint { public int X; public int Y; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out NativeRect value, int valueSize);
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern uint SendInput(uint count, ref NativeInput input, int size);

        private static void Check(bool value, string message)
        {
            if (!value) throw new InvalidOperationException("Click sampling fixture failed: " + message);
        }

        private static void MoveAndClick(int x, int y, uint flags)
        {
            Check(SetCursorPos(x, y), "could not position the synthetic cursor");
            var input = new NativeInput { Type = INPUT_MOUSE, Mouse = new MouseInput { Flags = flags } };
            Check(SendInput(1, ref input, Marshal.SizeOf(typeof(NativeInput))) == 1, "could not send a synthetic primary-button event");
        }

        [STAThread]
        internal static int Main()
        {
            IntPtr previousDpi = SetThreadDpiAwarenessContext(PerMonitorV2);
            using (var selected = new Form { Text = "Reel Click Target Fixture", Bounds = new Rectangle(120, 120, 420, 320), TopMost = true, ShowInTaskbar = false })
            using (var overlay = new Form { Text = "Reel Click Overlay Fixture", Bounds = new Rectangle(240, 220, 160, 120), TopMost = true, ShowInTaskbar = false })
            {
                selected.Show(); overlay.Show(); Application.DoEvents();
                SetForegroundWindow(selected.Handle); Application.DoEvents();
                NativeRect selectedRect;
                int dwmResult = DwmGetWindowAttribute(selected.Handle, DWMWA_EXTENDED_FRAME_BOUNDS, out selectedRect, Marshal.SizeOf(typeof(NativeRect)));
                bool visibleBounds = dwmResult == 0 && selectedRect.Right > selectedRect.Left && selectedRect.Bottom > selectedRect.Top;
                if (!visibleBounds) visibleBounds = GetWindowRect(selected.Handle, out selectedRect)
                    && selectedRect.Right > selectedRect.Left && selectedRect.Bottom > selectedRect.Top;
                Check(visibleBounds, "selected bounds unavailable");
                int targetX = selectedRect.Left + 60, targetY = selectedRect.Top + 70;
                uint down = GetSystemMetrics(SM_SWAPBUTTON) != 0 ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
                uint up = GetSystemMetrics(SM_SWAPBUTTON) != 0 ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
                MoveAndClick(targetX, targetY, up);
                var state = new ClickSamplerState(); var position = new ClickRingPosition();
                Check(!ClickSampling.TrySample(selected.Handle, ref state, out position), "button-up sample created a ring");
                MoveAndClick(targetX, targetY, down);
                Check(ClickSampling.TrySample(selected.Handle, ref state, out position), "selected-window press was not detected");
                double expectedX = (double)(targetX - selectedRect.Left) / (selectedRect.Right - selectedRect.Left);
                double expectedY = (double)(targetY - selectedRect.Top) / (selectedRect.Bottom - selectedRect.Top);
                Check(Math.Abs(position.X - expectedX) < 0.002 && Math.Abs(position.Y - expectedY) < 0.002,
                    "selected-window coordinates did not match the window bounds");
                MoveAndClick(targetX, targetY, up);
                ClickSampling.TrySample(selected.Handle, ref state, out position);

                Check(SetForegroundWindow(selected.Handle), "could not focus selected fixture window");
                Check(SetWindowPos(overlay.Handle, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW), "could not cover target with overlay fixture");
                Application.DoEvents();
                int overlayX = overlay.Left + overlay.Width / 2, overlayY = overlay.Top + overlay.Height / 2;
                Check(SetCursorPos(overlayX, overlayY), "could not position over the overlay fixture");
                IntPtr hit = WindowFromPoint(new NativePoint { X = overlayX, Y = overlayY });
                Check(GetAncestor(hit, 2) == overlay.Handle, "overlay did not occlude the selected fixture window");
                Check(GetForegroundWindow() == selected.Handle, "overlay unexpectedly took foreground focus");
                Check(!ClickSampling.TrySample(selected.Handle, ref state, out position), "overlay hit-test was attributed to the selected window");
                MoveAndClick(overlayX, overlayY, down);
                Check(!ClickSampling.TrySample(selected.Handle, ref state, out position), "overlay click generated a selected-window ring");
                MoveAndClick(overlayX, overlayY, up);
                Console.WriteLine("Selected-window click sampling passed: primary button only, foreground and point hit-test gated, normalized coordinates verified.");
            }
            if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
            return 0;
        }
    }
}
