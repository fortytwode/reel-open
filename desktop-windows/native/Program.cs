using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace ReelNative
{
    internal static class Program
    {
        private static readonly object outputGate = new object();
        private static readonly object pendingGate = new object();
        private static readonly Dictionary<string, CancellationTokenSource> pending = new Dictionary<string, CancellationTokenSource>();
        private static readonly WindowsJoiner joiner = new WindowsJoiner();
        private static readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private static readonly Regex IdShape = new Regex(@"\A[a-zA-Z0-9_-]{1,80}\z", RegexOptions.CultureInvariant);

        private static void Send(Dictionary<string, object> message)
        {
            lock (outputGate) { Console.Out.WriteLine(json.Serialize(message)); Console.Out.Flush(); }
        }

        private static Dictionary<string, object> Response(string id, bool ok, string state)
        {
            return new Dictionary<string, object> { { "v", 1 }, { "id", id }, { "ok", ok }, { "state", state } };
        }

        private static string Field(Dictionary<string, object> message, string key)
        {
            object value;
            return message.TryGetValue(key, out value) ? value as string : null;
        }

        private static bool Keys(Dictionary<string, object> message, params string[] allowed)
        {
            var set = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (string key in message.Keys) if (!set.Contains(key)) return false;
            return true;
        }

        private static string ReadBoundedLine()
        {
            var line = new StringBuilder();
            bool tooLong = false;
            while (true)
            {
                int character = Console.In.Read();
                if (character < 0) return line.Length == 0 && !tooLong ? null : tooLong ? "" : line.ToString();
                if (character == '\n') return tooLong ? "" : line.ToString().TrimEnd('\r');
                if (line.Length < 8192) line.Append((char)character);
                else tooLong = true;
            }
        }

        private static void Worker(Action action)
        {
            var thread = new Thread(() => { try { action(); } catch { } });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
        }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface DeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out AudioDevice device);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface AudioDevice
        {
            [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr activated);
            [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
            [PreserveSig] int GetId(out IntPtr id);
        }

        private static string DefaultRenderEndpoint()
        {
            DeviceEnumerator enumerator = null;
            AudioDevice device = null;
            IntPtr endpointId = IntPtr.Zero;
            try
            {
                var classId = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
                enumerator = (DeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(classId));
                const int render = 0, multimedia = 1;
                if (enumerator.GetDefaultAudioEndpoint(render, multimedia, out device) < 0 || device == null ||
                    device.GetId(out endpointId) < 0 || endpointId == IntPtr.Zero) return null;
                string value = Marshal.PtrToStringUni(endpointId);
                if (String.IsNullOrEmpty(value)) return null;
                using (var sha = SHA256.Create())
                    return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
            }
            catch { return null; }
            finally
            {
                if (endpointId != IntPtr.Zero) Marshal.FreeCoTaskMem(endpointId);
                if (device != null) Marshal.ReleaseComObject(device);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
        }

        private static void Handle(string line)
        {
            Dictionary<string, object> message;
            try { message = json.Deserialize<Dictionary<string, object>>(line); }
            catch { Send(Response("", false, "invalid_request")); return; }
            if (message == null) { Send(Response("", false, "invalid_request")); return; }
            object version;
            string id = Field(message, "id"), op = Field(message, "op");
            if (!message.TryGetValue("v", out version) || !(version is int) || (int)version != 1 ||
                id == null || !IdShape.IsMatch(id) || op == null)
            { Send(Response(id ?? "", false, "invalid_request")); return; }

            if (op == "defaultRenderEndpoint")
            {
                if (!Keys(message, "v", "id", "op"))
                { Send(Response(id, false, "invalid_request")); return; }
                Worker(() => {
                    string endpointId = DefaultRenderEndpoint();
                    var response = Response(id, endpointId != null, endpointId == null ? "endpoint_unavailable" : "endpoint_available");
                    if (endpointId != null) response["endpointId"] = endpointId;
                    Send(response);
                });
                return;
            }

            if (op == "openGoogleSignIn")
            {
                GoogleSignInUrl url;
                if (!Keys(message, "v", "id", "op", "url") || !GoogleSignInUrl.TryParse(Field(message, "url"), out url))
                { Send(Response(id, false, "invalid_request")); return; }
                var source = new CancellationTokenSource();
                lock (pendingGate)
                {
                    if (pending.Count != 0 || joiner.HasActiveSession) { source.Dispose(); Send(Response(id, false, "busy")); return; }
                    pending[id] = source;
                }
                Worker(() => {
                    string state;
                    try { state = joiner.OpenGoogleSignIn(url, source.Token); }
                    catch (OperationCanceledException) { state = "cancelled"; }
                    catch { state = "browser_failed"; }
                    lock (pendingGate) pending.Remove(id);
                    Send(Response(id, state == "browser_opened", state));
                    source.Dispose();
                });
                return;
            }

            if (op == "join")
            {
                object consent;
                ProviderUrl url;
                if (!Keys(message, "v", "id", "op", "url", "consentConfirmed") ||
                    !message.TryGetValue("consentConfirmed", out consent) || !(consent is bool) || !(bool)consent ||
                    !ProviderUrl.TryParse(Field(message, "url"), out url))
                { Send(Response(id, false, "invalid_join")); return; }
                var source = new CancellationTokenSource();
                lock (pendingGate)
                {
                    if (pending.ContainsKey(id)) { source.Dispose(); Send(Response(id, false, "duplicate_request")); return; }
                    if (pending.Count != 0 || joiner.HasActiveSession) { source.Dispose(); Send(Response(id, false, "busy")); return; }
                    pending[id] = source;
                }
                Worker(() => {
                    JoinResult result;
                    try { result = joiner.Join(url, source.Token); }
                    catch (OperationCanceledException) { result = new JoinResult("cancelled"); }
                    catch { result = new JoinResult("manual_required"); }
                    lock (pendingGate) pending.Remove(id);
                    var response = Response(id, result.State == "joined", result.State);
                    if (result.State == "joined" && result.Window != null)
                    {
                        response["sessionId"] = result.SessionId;
                        response["hwnd"] = unchecked((ulong)result.Window.Handle).ToString();
                        response["pid"] = result.Window.Pid;
                    }
                    Send(response);
                    source.Dispose();
                });
                return;
            }

            if (op == "cancel")
            {
                string joinId = Field(message, "joinId");
                if (!Keys(message, "v", "id", "op", "joinId") || joinId == null || !IdShape.IsMatch(joinId))
                { Send(Response(id, false, "invalid_request")); return; }
                CancellationTokenSource source;
                lock (pendingGate)
                {
                    pending.TryGetValue(joinId, out source);
                    if (source != null) source.Cancel();
                }
                if (source == null) { Send(Response(id, false, "not_pending")); return; }
                Send(Response(id, true, "cancellation_requested"));
                return;
            }

            if (op == "inspect" || op == "close")
            {
                string sessionId = Field(message, "sessionId");
                if (!Keys(message, "v", "id", "op", "sessionId") || sessionId == null ||
                    !Regex.IsMatch(sessionId, @"\A[0-9a-f]{32}\z"))
                { Send(Response(id, false, "invalid_request")); return; }
                Worker(() => {
                    string state = op == "inspect" ? joiner.Inspect(sessionId) : joiner.Close(sessionId);
                    Send(Response(id, op == "inspect" ? state != "unknown" : state == "closed" || state == "already_closed", state));
                });
                return;
            }
            Send(Response(id, false, "invalid_request"));
        }

        internal static int Main()
        {
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = new UTF8Encoding(false);
            while (true)
            {
                string line = ReadBoundedLine();
                if (line == null) break;
                if (line.Length == 0) Send(Response("", false, "invalid_request"));
                else Handle(line);
            }
            lock (pendingGate) foreach (CancellationTokenSource source in pending.Values) source.Cancel();
            return 0;
        }
    }
}
