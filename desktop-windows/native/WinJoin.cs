using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Microsoft.Win32;

namespace ReelNative
{
    internal sealed class JoinResult
    {
        internal string State;
        internal string SessionId;
        internal WindowIdentity Window;
        internal JoinResult(string state) { State = state; }
    }

    internal static class NativeWindows
    {
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lparam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
        [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

        internal static IList<WindowIdentity> Snapshot(string chromePath)
        {
            var found = new List<WindowIdentity>();
            EnumWindows((hwnd, unused) => {
                WindowIdentity value;
                if (TryIdentity(hwnd, chromePath, out value)) found.Add(value);
                return true;
            }, IntPtr.Zero);
            return found;
        }

        internal static bool TryIdentity(IntPtr hwnd, string chromePath, out WindowIdentity value)
        {
            value = null;
            if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || GetAncestor(hwnd, 2) != hwnd) return false;
            var className = new StringBuilder(128);
            if (GetClassName(hwnd, className, className.Capacity) == 0 ||
                !String.Equals(className.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return false;
            uint pid;
            if (GetWindowThreadProcessId(hwnd, out pid) == 0 || pid == 0) return false;
            IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (process == IntPtr.Zero) return false;
            string image;
            try {
                var name = new StringBuilder(1024);
                int length = name.Capacity;
                if (!QueryFullProcessImageName(process, 0, name, ref length)) return false;
                image = name.ToString();
            } finally { CloseHandle(process); }
            if (!String.Equals(image, chromePath, StringComparison.OrdinalIgnoreCase)) return false;
            long started;
            try { started = Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks; }
            catch { return false; }
            value = new WindowIdentity(hwnd.ToInt64(), (int)pid, image, started);
            return true;
        }

        internal static bool StillOwned(WindowIdentity original)
        {
            WindowIdentity now;
            return original != null && TryIdentity(new IntPtr(original.Handle), original.ImagePath, out now) && original.SameOwner(now);
        }

        internal static bool Close(WindowIdentity original)
        {
            return StillOwned(original) && PostMessage(new IntPtr(original.Handle), 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
        }

        internal static string FindChrome()
        {
            string[] keys = { @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" };
            foreach (string key in keys)
            {
                foreach (RegistryKey root in new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine })
                {
                    using (RegistryKey item = root.OpenSubKey(key))
                    {
                        string path = item == null ? null : item.GetValue("") as string;
                        if (!String.IsNullOrEmpty(path) && File.Exists(path) &&
                            String.Equals(Path.GetFileName(path), "chrome.exe", StringComparison.OrdinalIgnoreCase))
                            return Path.GetFullPath(path);
                    }
                }
            }
            foreach (string parent in new string[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
            {
                string path = Path.Combine(parent, "Google", "Chrome", "Application", "chrome.exe");
                if (File.Exists(path)) return Path.GetFullPath(path);
            }
            return null;
        }

        internal static bool StartBrowserProcess(string executable, string arguments)
        {
            // Chrome's handoff process can print to stdout. It must never inherit
            // the helper's JSON protocol streams, including its command input.
            var child = new Process();
            child.StartInfo = new ProcessStartInfo(executable, arguments) {
                UseShellExecute = false, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                CreateNoWindow = true
            };
            child.OutputDataReceived += (sender, value) => { };
            child.ErrorDataReceived += (sender, value) => { };
            child.Exited += (sender, value) => child.Dispose();
            try
            {
                if (!child.Start()) { child.Dispose(); return false; }
                child.StandardInput.Close();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                // Enable after starting both readers: a quick Chrome handoff
                // must not dispose the process before the drains are attached.
                child.EnableRaisingEvents = true;
                return true;
            }
            catch { child.Dispose(); throw; }
        }
    }

    internal sealed class ChromeControls
    {
        private readonly AutomationElement root;
        private readonly List<AutomationElement> nodes = new List<AutomationElement>();
        private readonly List<AutomationElement> buttons = new List<AutomationElement>();
        private readonly List<AutomationElement> documents = new List<AutomationElement>();

        internal ChromeControls(WindowIdentity window)
        {
            root = AutomationElement.FromHandle(new IntPtr(window.Handle));
            var queue = new Queue<Tuple<AutomationElement, int, bool>>();
            queue.Enqueue(Tuple.Create(root, 0, false));
            TreeWalker walker = TreeWalker.ControlViewWalker;
            DateTime deadline = DateTime.UtcNow.AddSeconds(2);
            while (queue.Count > 0)
            {
                if (DateTime.UtcNow > deadline || nodes.Count >= 1500) throw new InvalidOperationException("UIA_LIMIT");
                var pair = queue.Dequeue();
                nodes.Add(pair.Item1);
                ControlType type = pair.Item1.Current.ControlType;
                if (type == ControlType.Button) buttons.Add(pair.Item1);
                bool inDocument = pair.Item3 || type == ControlType.Document;
                if (type == ControlType.Document && !pair.Item3) documents.Add(pair.Item1);
                if (pair.Item2 >= 25) continue;
                AutomationElement child;
                try { child = walker.GetFirstChild(pair.Item1); }
                catch (ElementNotAvailableException) { continue; }
                int siblings = 0;
                while (child != null && siblings++ < 200 && queue.Count + nodes.Count < 1500)
                {
                    queue.Enqueue(Tuple.Create(child, pair.Item2 + 1, inDocument));
                    try { child = walker.GetNextSibling(child); }
                    catch (ElementNotAvailableException) { break; }
                }
            }
        }

        private static string Name(AutomationElement item)
        {
            try { return (item.Current.Name ?? "").Trim().ToLowerInvariant(); }
            catch (ElementNotAvailableException) { return ""; }
        }

        internal string Address()
        {
            // Chrome's unfocused address bar can omit the URL scheme. Its
            // document ValuePattern exposes the complete browser-owned URL
            // without moving focus. Exclude frame documents and fail closed
            // if multiple top-level documents make the active page ambiguous.
            if (documents.Count != 1) return null;
            try {
                object pattern;
                if (documents[0].TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                    return ((ValuePattern)pattern).Current.Value;
            } catch (ElementNotAvailableException) { }
            return null;
        }

        internal static bool Prefix(string value, params string[] names)
        {
            foreach (string name in names)
            {
                if (value == name || value.StartsWith(name + " (", StringComparison.Ordinal) ||
                    value.StartsWith(name + ",", StringComparison.Ordinal)) return true;
                // Meet exposes this exact camera-free Join variant when no camera is available.
                if (name == "join now" && value == "join now without camera") return true;
            }
            return false;
        }

        internal bool HasLeave() { return Button("leave call", "leave meeting", "leave") != null; }
        internal bool HasShare() { return Button("present now", "share screen", "share content", "stop presenting", "stop sharing") != null; }
        internal bool HasDenial() { return nodes.Exists(n => { string v = Name(n); return v.Contains("request to join was denied") || v.Contains("can't join this video call") || v.Contains("cannot join this meeting") || v.Contains("meeting has ended") || v.Contains("no one responded to your request"); }); }
        internal bool HasLobby() { return nodes.Exists(n => { string v = Name(n); return v.Contains("asking to join") || v.Contains("waiting for the host") || v.Contains("someone will let you in") || v.Contains("waiting for someone to let you in"); }); }
        internal bool NeedsSignIn() { return nodes.Exists(n => { string v = Name(n); return v == "sign in" || v.StartsWith("sign in to join", StringComparison.Ordinal) || v == "your name" || v.Contains("enter your name"); }); }
        internal bool NeedsManual()
        {
            return nodes.Exists(n => {
                string v = Name(n);
                return v.Contains("verify it's you") || v.Contains("enter your password") ||
                    v.Contains("allow microphone access") || v.Contains("allow camera access") ||
                    v == "do you want people to hear you in the meeting?";
            }) || buttons.Exists(n => {
                string v = Name(n);
                return v == "use microphone" || v == "use microphone and camera";
            });
        }
        private AutomationElement Button(params string[] names)
        {
            AutomationElement found = null;
            foreach (AutomationElement button in buttons)
            {
                if (!Prefix(Name(button), names)) continue;
                if (found != null) return null; // Ambiguous controls never receive an action.
                found = button;
            }
            return found;
        }
        internal bool MicOff() { return Button("turn on microphone", "unmute microphone", "unmute") != null; }
        internal bool CameraOff() { return Button("turn on camera", "start video") != null; }
        internal bool TurnMicOff(CancellationToken token) { return Invoke(Button("turn off microphone", "mute microphone"), token); }
        internal bool TurnCameraOff(CancellationToken token) { return Invoke(Button("turn off camera", "stop video"), token); }
        internal bool MicOn() { return Button("turn off microphone", "mute microphone") != null; }
        internal bool CameraOn() { return Button("turn off camera", "stop video") != null; }
        internal bool ContinueBrowser(CancellationToken token) { return Invoke(Button("continue on this browser", "join from your browser", "join on the web instead"), token); }
        internal bool HasBrowserChoice() { return Button("continue on this browser", "join from your browser", "join on the web instead") != null; }
        internal bool HasJoin() { return Button("join now", "ask to join", "join meeting") != null; }
        internal bool PressJoin(CancellationToken token) { return Invoke(Button("join now", "ask to join", "join meeting"), token); }
        private static bool Invoke(AutomationElement node, CancellationToken token)
        {
            if (node == null || token.IsCancellationRequested) return false;
            try {
                object pattern;
                if (!node.Current.IsEnabled || !node.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) return false;
                token.ThrowIfCancellationRequested();
                ((InvokePattern)pattern).Invoke();
                return true;
            } catch (ElementNotAvailableException) { return false; }
        }
    }

    internal sealed class WindowSession
    {
        internal readonly string Id = Guid.NewGuid().ToString("N");
        internal readonly WindowIdentity Window;
        internal readonly ProviderUrl Url;
        internal WindowSession(WindowIdentity window, ProviderUrl url) { Window = window; Url = url; }
    }

    internal sealed class WindowsJoiner
    {
        private readonly Dictionary<string, WindowSession> sessions = new Dictionary<string, WindowSession>();
        private readonly object gate = new object();
        internal bool HasActiveSession { get { lock (gate) return sessions.Count != 0; } }

        private static bool MatchesAddress(ChromeControls controls, ProviderUrl expected)
        {
            ProviderUrl observed;
            return ProviderUrl.TryParse(controls.Address(), out observed) && expected.SameAddress(observed);
        }

        internal string OpenGoogleSignIn(GoogleSignInUrl url, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            string chromePath = NativeWindows.FindChrome();
            if (chromePath == null) return "chrome_unavailable";
            IList<WindowIdentity> before = NativeWindows.Snapshot(chromePath);
            token.ThrowIfCancellationRequested();
            if (!NativeWindows.StartBrowserProcess(chromePath, "--new-window \"" + url.Url + "\""))
                return "browser_failed";
            // Chrome may hand off to its existing process. Keep the shared
            // pending gate until a window appears before another join snapshots
            // Chrome. Auth windows never become Reel-owned meeting sessions.
            DateTime deadline = DateTime.UtcNow.AddSeconds(12);
            while (DateTime.UtcNow < deadline)
            {
                token.ThrowIfCancellationRequested();
                foreach (WindowIdentity candidate in NativeWindows.Snapshot(chromePath))
                {
                    bool existed = false;
                    foreach (WindowIdentity old in before) if (old.Handle == candidate.Handle) { existed = true; break; }
                    if (!existed) return "browser_opened";
                }
                token.WaitHandle.WaitOne(150);
            }
            return "browser_failed";
        }

        internal JoinResult Join(ProviderUrl url, CancellationToken token)
        {
            string chromePath = NativeWindows.FindChrome();
            if (chromePath == null) return new JoinResult("chrome_unavailable");
            IList<WindowIdentity> before = NativeWindows.Snapshot(chromePath);
            token.ThrowIfCancellationRequested();
            if (!NativeWindows.StartBrowserProcess(chromePath, "--new-window \"" + url.Url + "\""))
                return new JoinResult("manual_required");
            WindowIdentity owned = null;
            DateTime windowDeadline = DateTime.UtcNow.AddSeconds(12);
            while (DateTime.UtcNow < windowDeadline)
            {
                if (token.IsCancellationRequested)
                {
                    WindowIdentity created;
                    if (WindowOwnership.SelectUniqueNew(before, NativeWindows.Snapshot(chromePath), chromePath, out created))
                    {
                        try { if (MatchesAddress(new ChromeControls(created), url)) NativeWindows.Close(created); }
                        catch { }
                    }
                    return new JoinResult("cancelled");
                }
                IList<WindowIdentity> after = NativeWindows.Snapshot(chromePath);
                if (WindowOwnership.SelectUniqueNew(before, after, chromePath, out owned)) break;
                if (after.Count > before.Count + 1) return new JoinResult("ambiguous_window");
                token.WaitHandle.WaitOne(150);
            }
            if (owned == null) return new JoinResult("dedicated_window_unavailable");
            DateTime deadline = DateTime.UtcNow.AddSeconds(90);
            DateTime addressDeadline = DateTime.UtcNow.AddSeconds(10);
            bool requested = false, lobby = false;
            try {
                while (DateTime.UtcNow < deadline)
                {
                    token.ThrowIfCancellationRequested();
                    if (!NativeWindows.StillOwned(owned)) return new JoinResult("manual_required");
                    ChromeControls ui;
                    try { ui = new ChromeControls(owned); }
                    catch (ElementNotAvailableException) {
                        // Chrome can replace accessibility nodes while the meeting
                        // page loads. Re-read the owned window on the next pass.
                        token.WaitHandle.WaitOne(250);
                        continue;
                    }
                    catch { return new JoinResult("manual_required"); }
                    if (!MatchesAddress(ui, url))
                    {
                        if (DateTime.UtcNow >= addressDeadline) return new JoinResult("manual_required");
                        token.WaitHandle.WaitOne(250);
                        continue;
                    }
                    if (ui.HasLeave() && ui.HasShare())
                    {
                        if (!ui.MicOff() || !ui.CameraOff() || ui.MicOn() || ui.CameraOn()) return new JoinResult("manual_required");
                        token.ThrowIfCancellationRequested();
                        var session = new WindowSession(owned, url);
                        lock (gate) sessions[session.Id] = session;
                        return new JoinResult("joined") { SessionId = session.Id, Window = owned };
                    }
                    if (ui.HasDenial()) return new JoinResult("denied");
                    if (ui.HasLobby()) { lobby = true; requested = true; }
                    if (ui.NeedsSignIn()) return new JoinResult("sign_in_required");
                    if (ui.NeedsManual()) return new JoinResult("manual_required");
                    if ((ui.MicOn() && ui.MicOff()) || (ui.CameraOn() && ui.CameraOff())) return new JoinResult("manual_required");
                    if (!requested)
                    {
                        if (ui.HasBrowserChoice()) { if (!ui.ContinueBrowser(token)) return new JoinResult("manual_required"); }
                        else
                        {
                            // Media warnings can change Join's accessible label.
                            // Disable known active inputs independently; Join still
                            // requires its own recognized control and both off states.
                            if (ui.MicOn()) { if (!ui.TurnMicOff(token)) return new JoinResult("manual_required"); }
                            else if (ui.CameraOn()) { if (!ui.TurnCameraOff(token)) return new JoinResult("manual_required"); }
                            else if (ui.MicOff() && ui.CameraOff() && ui.HasJoin())
                            {
                                if (!ui.PressJoin(token)) return new JoinResult("manual_required");
                                requested = true;
                            }
                            // Meet can expose Join before its media controls
                            // finish loading. Re-scan within the existing deadline;
                            // never join until both explicit off states are present.
                        }
                    }
                    token.WaitHandle.WaitOne(500);
                }
                return new JoinResult(lobby ? "awaiting_admission" : "timed_out");
            } catch (OperationCanceledException) {
                // This is a window created by this request; never terminate Chrome itself.
                if (NativeWindows.StillOwned(owned)) {
                    try { if (MatchesAddress(new ChromeControls(owned), url)) NativeWindows.Close(owned); }
                    catch { }
                }
                return new JoinResult("cancelled");
            }
        }

        internal string Inspect(string sessionId)
        {
            WindowSession session;
            lock (gate) if (!sessions.TryGetValue(sessionId, out session)) return "unknown";
            if (!NativeWindows.StillOwned(session.Window)) return "left";
            try {
                var ui = new ChromeControls(session.Window);
                if (!MatchesAddress(ui, session.Url)) return "unknown";
                return ui.HasLeave() && ui.HasShare() ? "in_call" : "unknown";
            } catch { return "unknown"; }
        }

        internal string Close(string sessionId)
        {
            WindowSession session;
            lock (gate) if (!sessions.TryGetValue(sessionId, out session)) return "not_owned";
            if (!NativeWindows.StillOwned(session.Window)) { lock (gate) sessions.Remove(sessionId); return "already_closed"; }
            try {
                if (!MatchesAddress(new ChromeControls(session.Window), session.Url))
                {
                    lock (gate) sessions.Remove(sessionId);
                    return "released"; // The user navigated away; never close unrelated content.
                }
                if (!NativeWindows.Close(session.Window)) return "close_failed";
                for (int i = 0; i < 20 && NativeWindows.StillOwned(session.Window); i++) Thread.Sleep(100);
                if (NativeWindows.StillOwned(session.Window)) return "close_pending";
                lock (gate) sessions.Remove(sessionId);
                return "closed";
            } catch {
                lock (gate) sessions.Remove(sessionId);
                return "released";
            }
        }
    }
}
