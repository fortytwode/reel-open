using System;
using System.Runtime.InteropServices;

namespace ReelNative
{
    internal struct ClickRingPosition
    {
        internal double X;
        internal double Y;
        internal ClickRingPosition(double x, double y) { X = x; Y = y; }
    }

    internal struct ClickSamplerState
    {
        internal bool WasDown;
        internal bool Armed;
    }

    internal static class ClickSampling
    {
        private const int VK_LBUTTON = 0x01;
        private const int VK_RBUTTON = 0x02;
        private const int SM_SWAPBUTTON = 23;
        private const uint GA_ROOT = 2;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);

        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(NativePoint point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativePoint point);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int virtualKey);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out NativeRect value, int valueSize);

        /// Poll only after foreground and point hit-testing resolve to the selected window.
        /// No input hook is installed and no button/key state is read outside that target.
        internal static bool TrySample(IntPtr selected, ref ClickSamplerState state, out ClickRingPosition position)
        {
            position = new ClickRingPosition();
            if (selected == IntPtr.Zero || !IsWindow(selected)) { state.WasDown = false; state.Armed = false; return false; }
            IntPtr oldDpi = SetThreadDpiAwarenessContext(PerMonitorV2);
            if (oldDpi == IntPtr.Zero) { state.WasDown = false; state.Armed = false; return false; }
            try
            {
                if (Root(GetForegroundWindow()) != selected) { state.WasDown = false; state.Armed = false; return false; }
                NativePoint cursor;
                if (!GetCursorPos(out cursor) || Root(WindowFromPoint(cursor)) != selected)
                { state.WasDown = false; state.Armed = false; return false; }
                NativeRect rect;
                if (!VisibleFrame(selected, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top ||
                    cursor.X < rect.Left || cursor.X >= rect.Right || cursor.Y < rect.Top || cursor.Y >= rect.Bottom)
                { state.WasDown = false; state.Armed = false; return false; }

                int primaryButton = GetSystemMetrics(SM_SWAPBUTTON) != 0 ? VK_RBUTTON : VK_LBUTTON;
                bool down = (GetAsyncKeyState(primaryButton) & unchecked((short)0x8000)) != 0;
                if (!down)
                {
                    state.WasDown = false;
                    state.Armed = true;
                    return false;
                }
                bool pressed = state.Armed && !state.WasDown;
                state.WasDown = down;
                state.Armed = false;
                if (!pressed) return false;
                double x = (double)(cursor.X - rect.Left) / (rect.Right - rect.Left);
                double y = (double)(cursor.Y - rect.Top) / (rect.Bottom - rect.Top);
                position = new ClickRingPosition(Math.Max(0, Math.Min(1, x)), Math.Max(0, Math.Min(1, y)));
                return true;
            }
            finally { if (oldDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(oldDpi); }
        }

        private static bool VisibleFrame(IntPtr hwnd, out NativeRect rect)
        {
            int result = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(NativeRect)));
            if (result == 0 && rect.Right > rect.Left && rect.Bottom > rect.Top) return true;
            return GetWindowRect(hwnd, out rect);
        }

        private static IntPtr Root(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return IntPtr.Zero;
            IntPtr root = GetAncestor(hwnd, GA_ROOT);
            return root == IntPtr.Zero ? hwnd : root;
        }
    }
}
