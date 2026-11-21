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
        private const string MeetMediaOffer = "do you want people to hear you in the meeting?";

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
                    v.Contains("allow microphone access") || v.Contains("allow camera access");
            });
        }
        internal bool HasMeetMediaOffer()
        {
            return nodes.Exists(n => Name(n) == MeetMediaOffer) || buttons.Exists(n => {
                string v = Name(n);
                return v == "use microphone" || v == "use microphone and camera";
            });
        }
        private AutomationElementCollection FindDocumentMeetMediaOffer()
        {
            if (documents.Count != 1) return null;
            return documents[0].FindAll(TreeScope.Descendants, new OrCondition(
                new PropertyCondition(AutomationElement.NameProperty, MeetMediaOffer, PropertyConditionFlags.IgnoreCase),
                new PropertyCondition(AutomationElement.NameProperty, "use microphone", PropertyConditionFlags.IgnoreCase),
                new PropertyCondition(AutomationElement.NameProperty, "use microphone and camera", PropertyConditionFlags.IgnoreCase),
                new PropertyCondition(AutomationElement.NameProperty, "close dialog", PropertyConditionFlags.IgnoreCase)));
        }

        internal bool HasDocumentMeetMediaOffer()
        {
            bool present;
            return TryReadDocumentMeetMediaOffer(out present) && present;
        }

        private bool TryReadDocumentMeetMediaOffer(out bool present)
        {
            present = false;
            try
            {
                AutomationElementCollection controls = FindDocumentMeetMediaOffer();
                if (controls == null) return false;
                foreach (AutomationElement node in controls)
                {
                    string name = (node.Current.Name ?? "").Trim().ToLowerInvariant();
                    if ((name == MeetMediaOffer || name == "use microphone" || name == "use microphone and camera") &&
                        !node.Current.IsOffscreen) { present = true; break; }
                }
                return true;
            }
            catch (ElementNotAvailableException) { return false; }
        }

        internal bool MeetMicPermissionNeeded()
        {
            if (documents.Count != 1 || !MeetPermissionStateClear()) return false;
            try
            {
                var condition = new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                    new PropertyCondition(AutomationElement.NameProperty, "microphone: permission needed", PropertyConditionFlags.IgnoreCase));
                AutomationElementCollection candidates = documents[0].FindAll(TreeScope.Descendants, condition);
                if (candidates.Count != 1) return false;
                AutomationElement button = candidates[0];
                string name = Name(button);
                object pattern;
                return name == "microphone: permission needed" &&
                    button.Current.ControlType == ControlType.Button && HasLiveAncestor(button, documents[0], true) &&
                    !button.Current.IsOffscreen && !button.Current.IsEnabled && !button.Current.IsKeyboardFocusable &&
                    !button.TryGetCurrentPattern(InvokePattern.Pattern, out pattern) &&
                    !button.TryGetCurrentPattern(TogglePattern.Pattern, out pattern);
            }
            catch (ElementNotAvailableException) { return false; }
        }

        internal bool MeetPermissionStateClear(bool requireCallControls = false)
        {
            bool offerPresent;
            return !NeedsSignIn() && !NeedsManual() && !HasDenial() && !HasMeetMediaOffer() &&
                !buttons.Exists(button => Prefix(Name(button), "turn off microphone", "mute microphone", "mute my microphone")) &&
                !nodes.Exists(node => IsMeetPermissionPrompt(Name(node))) &&
                TryReadDocumentMeetMediaOffer(out offerPresent) && !offerPresent &&
                MeetDocumentMicAndPromptClear(requireCallControls);
        }

        private bool MeetDocumentMicAndPromptClear(bool requireCallControls)
        {
            if (documents.Count != 1) return false;
            try
            {
                // The capped walking snapshot can miss active controls. For
                // this permission fallback, require a fresh document query.
                var visibleButton = new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                    new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
                bool leave = false, share = false, cameraOff = false;
                var controls = documents[0].FindAll(TreeScope.Descendants, visibleButton);
                if (controls.Count == 0) return false;
                foreach (AutomationElement button in controls)
                {
                    string name = (button.Current.Name ?? "").Trim().ToLowerInvariant();
                    if (Prefix(name, "turn off microphone", "mute microphone", "mute my microphone") ||
                        IsMeetPermissionPrompt(name)) return false;
                    if (!requireCallControls) continue;
                    if (Prefix(name, "turn off camera", "stop video")) return false;
                    if (Prefix(name, "leave call", "leave meeting", "leave")) leave = true;
                    if (Prefix(name, "present now", "share screen", "share content", "stop presenting", "stop sharing")) share = true;
                    if (Prefix(name, "turn on camera", "start video")) cameraOff = true;
                }
                return !requireCallControls || (leave && share && cameraOff);
            }
            catch (ElementNotAvailableException) { return false; }
            catch (InvalidOperationException) { return false; }
            catch (COMException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        internal static bool IsMeetPermissionPrompt(string name)
        {
            switch (name)
            {
                case "allow this time":
                case "allow while visiting the site":
                case "never allow":
                case "use your microphone":
                case "use your camera":
                case "use your microphone and camera":
                case "meet.google.com wants to use your microphone":
                case "meet.google.com wants to use your camera":
                case "meet.google.com wants to use your microphone and camera":
                    return true;
                default: return false;
            }
        }

        private Dictionary<AutomationElement, List<AutomationElement>> DocumentMeetMediaOfferDialogs()
        {
            var dialogs = new Dictionary<AutomationElement, List<AutomationElement>>();
            AutomationElementCollection controls = FindDocumentMeetMediaOffer();
            if (controls == null) return dialogs;
            TreeWalker walker = TreeWalker.ControlViewWalker;
            foreach (AutomationElement node in controls)
            {
                if (node.Current.IsOffscreen) continue;
                AutomationElement ancestor = node;
                for (int depth = 0; depth < 25; depth++)
                {
                    ancestor = walker.GetParent(ancestor);
                    if (ancestor == null || ancestor == documents[0] ||
                        ancestor.Current.ControlType == ControlType.Document) break;
                    // Chromium exposes its web dialog as a Window under the document.
                    if (ancestor.Current.ControlType != ControlType.Window) continue;
                    if (!HasLiveAncestor(ancestor, documents[0])) break;
                    List<AutomationElement> members;
                    if (!dialogs.TryGetValue(ancestor, out members))
                    {
                        members = new List<AutomationElement>();
                        dialogs.Add(ancestor, members);
                    }
                    if (!members.Contains(node)) members.Add(node);
                    break;
                }
            }
            return dialogs;
        }

        internal bool DismissMeetMediaOffer(Func<bool> stillMatches, CancellationToken token)
        {
            if (documents.Count != 1) return false;
            try
            {
                AutomationElement matchedDialog = null, heading = null, close = null;
                foreach (var dialog in DocumentMeetMediaOfferDialogs())
                {
                    AutomationElement candidateHeading = dialog.Value.Find(node =>
                        Name(node) == MeetMediaOffer && !node.Current.IsOffscreen);
                    if (candidateHeading == null) continue;
                    var visibleButtons = new List<AutomationElement>();
                    var buttonNames = new List<string>();
                    foreach (AutomationElement node in dialog.Value)
                    {
                        string name = Name(node);
                        if (name != "use microphone" && name != "use microphone and camera" && name != "close dialog")
                            continue;
                        if (node.Current.ControlType != ControlType.Button || node.Current.IsOffscreen) continue;
                        visibleButtons.Add(node);
                        buttonNames.Add(name);
                    }
                    int index = MeetMediaOfferCloseIndex(buttonNames);
                    if (index < 0 || matchedDialog != null) return false;
                    matchedDialog = dialog.Key;
                    heading = candidateHeading;
                    close = visibleButtons[index];
                }
                if (matchedDialog == null || token.IsCancellationRequested || !stillMatches()) return false;
                if (matchedDialog.Current.ControlType != ControlType.Window || matchedDialog.Current.IsOffscreen ||
                    !HasLiveAncestor(matchedDialog, documents[0]) ||
                    !HasLiveAncestor(heading, matchedDialog) || !HasLiveAncestor(close, matchedDialog)) return false;
                if (heading.Current.IsOffscreen || Name(heading) != MeetMediaOffer ||
                    close.Current.ControlType != ControlType.Button || close.Current.IsOffscreen ||
                    Name(close) != "close dialog") return false;
                return Invoke(close, token);
            }
            catch (ElementNotAvailableException) { return false; }
        }

        private static bool HasLiveAncestor(AutomationElement node, AutomationElement ancestor, bool allowWindows = false)
        {
            TreeWalker walker = TreeWalker.ControlViewWalker;
            for (int i = 0; i < 25; i++)
            {
                node = walker.GetParent(node);
                if (node == null) return false;
                if (node == ancestor) return true;
                ControlType type = node.Current.ControlType;
                if (type == ControlType.Document || (!allowWindows && type == ControlType.Window)) return false;
            }
            return false;
        }

        internal static int MeetMediaOfferCloseIndex(IList<string> names)
        {
            int close = -1;
            bool useMic = false, useMicAndCamera = false;
            for (int i = 0; i < names.Count; i++)
            {
                switch (names[i])
                {
                    case "use microphone": useMic = true; break;
                    case "use microphone and camera": useMicAndCamera = true; break;
                    case "close dialog":
                        if (close != -1) return -1;
                        close = i;
                        break;
                }
            }
            return useMic && useMicAndCamera ? close : -1;
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
        internal bool MeetCameraExplicitlyOff()
        {
            return !buttons.Exists(button => Prefix(Name(button), "turn off camera", "stop video")) &&
                IsVisibleMeetControl(Button("turn on camera"));
        }
        internal bool HasVisibleMeetCallControls()
        {
            return IsVisibleMeetControl(Button("leave call", "leave meeting", "leave")) &&
                IsVisibleMeetControl(Button("present now", "share screen", "share content", "stop presenting", "stop sharing"));
        }
        internal bool TurnMeetCameraOff(CancellationToken token)
        {
            AutomationElement camera = Button("turn off camera");
            return IsVisibleMeetControl(camera) && Invoke(camera, token);
        }
        internal bool PressMeetJoin(CancellationToken token)
        {
            AutomationElement join = Button("join now", "ask to join", "join meeting");
            return IsVisibleMeetControl(join) && Invoke(join, token);
        }
        private bool IsVisibleMeetControl(AutomationElement button)
        {
            if (button == null || documents.Count != 1) return false;
            try
            {
                return HasLiveAncestor(button, documents[0], true) &&
                    button.Current.ControlType == ControlType.Button && !button.Current.IsOffscreen && button.Current.IsEnabled;
            }
            catch (ElementNotAvailableException) { return false; }
        }
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

        internal static bool MeetPermissionProofBelongsToJoin(Provider provider,
            bool offerDismissed, bool permissionVerified, bool joinInvoked)
        {
            return provider == Provider.GoogleMeet && offerDismissed && permissionVerified && joinInvoked;
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
            bool requested = false, lobby = false, cameraOffAfterOfferRequested = false;
            DateTime mediaOfferDismissalDeadline = DateTime.MinValue;
            DateTime meetMicOffDeadline = DateTime.MinValue;
            DateTime meetPermissionProofUntil = DateTime.MinValue;
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
                        if (meetPermissionProofUntil != DateTime.MinValue)
                        {
                            if (!ui.HasVisibleMeetCallControls() || !ui.MeetCameraExplicitlyOff() ||
                                !ui.MeetPermissionStateClear(true) ||
                                (!ui.MicOff() && DateTime.UtcNow > meetPermissionProofUntil))
                                return new JoinResult("manual_required");
                        }
                        else if (!ui.MicOff() || !ui.CameraOff() || ui.MicOn() || ui.CameraOn())
                            return new JoinResult("manual_required");
                        token.ThrowIfCancellationRequested();
                        var session = new WindowSession(owned, url);
                        lock (gate) sessions[session.Id] = session;
                        return new JoinResult("joined") { SessionId = session.Id, Window = owned };
                    }
                    if (ui.HasDenial()) return new JoinResult("denied");
                    if (ui.HasLobby()) { lobby = true; requested = true; }
                    if (ui.NeedsSignIn()) return new JoinResult("sign_in_required");
                    if (ui.NeedsManual()) return new JoinResult("manual_required");
                    bool offerInWalker = ui.HasMeetMediaOffer();
                    bool offerInDocument = !offerInWalker && url.Kind == Provider.GoogleMeet && !requested &&
                        meetMicOffDeadline != DateTime.MinValue && !ui.MicOff() && ui.HasDocumentMeetMediaOffer();
                    if (offerInWalker || offerInDocument)
                    {
                        if (url.Kind != Provider.GoogleMeet || requested)
                            return new JoinResult("manual_required");
                        if (mediaOfferDismissalDeadline == DateTime.MinValue)
                        {
                            if (!ui.DismissMeetMediaOffer(() => NativeWindows.StillOwned(owned) && MatchesAddress(ui, url), token))
                                return new JoinResult("manual_required");
                            mediaOfferDismissalDeadline = DateTime.UtcNow.AddSeconds(3);
                        }
                        else if (DateTime.UtcNow >= mediaOfferDismissalDeadline)
                            return new JoinResult("manual_required");
                        token.WaitHandle.WaitOne(500);
                        continue;
                    }
                    if ((ui.MicOn() && ui.MicOff()) || (ui.CameraOn() && ui.CameraOff())) return new JoinResult("manual_required");
                    bool meetOfferDismissed = !requested && url.Kind == Provider.GoogleMeet &&
                        mediaOfferDismissalDeadline != DateTime.MinValue;
                    bool meetMicPermissionNeeded = meetOfferDismissed && !ui.MicOff() && ui.MeetMicPermissionNeeded();
                    if (meetOfferDismissed && !cameraOffAfterOfferRequested && !ui.MicOff() && ui.CameraOn())
                    {
                        cameraOffAfterOfferRequested = true;
                        if (!NativeWindows.StillOwned(owned) || !MatchesAddress(ui, url) || !ui.TurnMeetCameraOff(token))
                            return new JoinResult("manual_required");
                        token.WaitHandle.WaitOne(500);
                        continue;
                    }
                    if (!requested && meetMicOffDeadline != DateTime.MinValue && !ui.MicOff() && !meetMicPermissionNeeded)
                    {
                        if (DateTime.UtcNow >= meetMicOffDeadline) return new JoinResult("manual_required");
                        token.WaitHandle.WaitOne(500);
                        continue;
                    }
                    if (!requested)
                    {
                        if (ui.HasBrowserChoice()) { if (!ui.ContinueBrowser(token)) return new JoinResult("manual_required"); }
                        else
                        {
                            // Media warnings can change Join's accessible label.
                            // Disable known active inputs independently; Join still
                            // requires its own recognized control and both off states.
                            if (ui.MicOn())
                            {
                                if (url.Kind == Provider.GoogleMeet)
                                {
                                    // An accessibility invoke can return before Meet updates its
                                    // state or opens its microphone offer. Do not toggle again
                                    // until a fresh, owned snapshot confirms the microphone is off.
                                    meetMicOffDeadline = DateTime.UtcNow.AddSeconds(28);
                                    ui.TurnMicOff(token);
                                }
                                else if (!ui.TurnMicOff(token)) return new JoinResult("manual_required");
                            }
                            else if (ui.CameraOn() && !cameraOffAfterOfferRequested) { if (!ui.TurnCameraOff(token)) return new JoinResult("manual_required"); }
                            else if ((ui.MicOff() || meetMicPermissionNeeded) && ui.CameraOff() && ui.HasJoin())
                            {
                                if (meetMicPermissionNeeded &&
                                    (!NativeWindows.StillOwned(owned) || !MatchesAddress(ui, url) ||
                                     !ui.MeetMicPermissionNeeded() || !ui.MeetCameraExplicitlyOff()))
                                    return new JoinResult("manual_required");
                                bool joinInvoked = meetMicPermissionNeeded ? ui.PressMeetJoin(token) : ui.PressJoin(token);
                                if (!joinInvoked) return new JoinResult("manual_required");
                                // Only our guarded Join can carry permission-needed evidence
                                // across the immediate transition into this same owned call.
                                if (MeetPermissionProofBelongsToJoin(url.Kind, meetOfferDismissed, meetMicPermissionNeeded, joinInvoked))
                                    meetPermissionProofUntil = DateTime.UtcNow.AddSeconds(20);
                                requested = true;
                            }
                            // Meet can expose Join before its media controls
                            // finish loading. Re-scan within the existing deadline;
                            // wait for the known device controls before joining.
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
