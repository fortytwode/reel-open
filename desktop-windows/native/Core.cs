using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace ReelNative
{
    internal sealed class GoogleSignInUrl
    {
        private static readonly Regex Shape = new Regex(@"\Ahttps://([^/?#]+)(/[^?#]*)(\?[^#]*)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        internal readonly string Url;
        private GoogleSignInUrl(string url) { Url = url; }

        internal static bool TryParse(string input, out GoogleSignInUrl result)
        {
            result = null;
            if (String.IsNullOrEmpty(input) || input.Length > 4096 || input.IndexOf('\\') >= 0 ||
                input.IndexOf('"') >= 0 || input.IndexOf('\'') >= 0) return false;
            foreach (char c in input) if (Char.IsControl(c) || Char.IsWhiteSpace(c)) return false;
            Match raw = Shape.Match(input);
            if (!raw.Success || !Regex.IsMatch(raw.Groups[1].Value, @"\Aaccounts\.google\.com(:443)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ||
                raw.Groups[2].Value != "/o/oauth2/v2/auth") return false;
            Uri uri;
            if (!Uri.TryCreate(input, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps ||
                uri.Host != "accounts.google.com" || uri.Port != 443 || !String.IsNullOrEmpty(uri.UserInfo) ||
                !String.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != raw.Groups[2].Value) return false;
            result = new GoogleSignInUrl(input);
            return true;
        }
    }

    internal enum Provider { GoogleMeet, Zoom, Teams
#if TEST_FIXTURE
        , Fixture
#endif
    }

    internal sealed class ProviderUrl
    {
        private static readonly Regex Shape = new Regex(@"\Ahttps?://([^/?#]+)(/[^?#]*)(\?[^#]*)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex Meet = new Regex(@"\A/(meet/)?[a-z]{3}-[a-z]{4}-[a-z]{3}/?\z", RegexOptions.CultureInvariant);
        private static readonly Regex Zoom = new Regex(@"\A(/j/[0-9]{9,11}/?|/wc/[0-9]{9,11}/join/?)\z", RegexOptions.CultureInvariant);
        private static readonly Regex Teams = new Regex(@"\A(/l/meetup-join/[^/]+/[0-9]+/?|/meet/[0-9]+/?)\z", RegexOptions.CultureInvariant);
        internal readonly string Url;
        internal readonly string Host;
        internal readonly string Path;
        internal readonly string Query;
        internal readonly Provider Kind;

        private ProviderUrl(string url, string host, string path, string query, Provider provider)
        {
            Url = url; Host = host; Path = path; Query = query; Kind = provider;
        }

        internal static bool TryParse(string input, out ProviderUrl result)
        {
            result = null;
            if (String.IsNullOrEmpty(input) || input.Length > 4096 || input.IndexOf('\\') >= 0 || input.IndexOf('"') >= 0) return false;
            foreach (char c in input) if (Char.IsControl(c) || Char.IsWhiteSpace(c)) return false;
            Match m = Shape.Match(input);
            if (!m.Success) return false;
            Uri uri;
            if (!Uri.TryCreate(input, UriKind.Absolute, out uri) ||
                !String.IsNullOrEmpty(uri.UserInfo) || !String.IsNullOrEmpty(uri.Fragment) ||
                uri.Host.EndsWith(".", StringComparison.Ordinal)) return false;
#if TEST_FIXTURE
            if (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.Host == "127.0.0.1")) return false;
#else
            if (uri.Scheme != Uri.UriSchemeHttps) return false;
#endif
            if (uri.Port != 443)
            {
#if TEST_FIXTURE
                if (!(uri.Host == "127.0.0.1" && uri.Port >= 1024 && uri.Port <= 65535)) return false;
#else
                return false;
#endif
            }
            string authority = m.Groups[1].Value;
            string host = uri.Host.ToLowerInvariant();
            if (!String.Equals(authority, host, StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(authority, host + ":" + uri.Port, StringComparison.OrdinalIgnoreCase)) return false;
            string path = m.Groups[2].Value;
            Provider provider;
            if (host == "meet.google.com" && Meet.IsMatch(path)) provider = Provider.GoogleMeet;
            else if ((host == "zoom.us" || host.EndsWith(".zoom.us", StringComparison.Ordinal)) && Zoom.IsMatch(path)) provider = Provider.Zoom;
            else if (host == "teams.microsoft.com" && Teams.IsMatch(path)) provider = Provider.Teams;
            else if (host == "teams.live.com" && Regex.IsMatch(path, @"\A/meet/[0-9]+/?\z", RegexOptions.CultureInvariant)) provider = Provider.Teams;
#if TEST_FIXTURE
            else if (host == "127.0.0.1" && uri.Port >= 1024 && uri.Port <= 65535 && path == "/fixture") provider = Provider.Fixture;
#endif
            else return false;
            string query = m.Groups[3].Success ? m.Groups[3].Value : "";
            result = new ProviderUrl(input, host, path.TrimEnd('/'), query, provider);
            return true;
        }

        internal bool SameAddress(ProviderUrl other)
        {
            if (other == null || Kind != other.Kind || Host != other.Host) return false;
            if (Kind == Provider.GoogleMeet)
            {
                // Google redirects /<code> to /meet/<code>?pli=1. Only that
                // observed routing flag is ignored; account and other query
                // parameters still have to match exactly.
                string leftPath = Path.StartsWith("/meet/", StringComparison.Ordinal) ? Path.Substring(5) : Path;
                string rightPath = other.Path.StartsWith("/meet/", StringComparison.Ordinal) ? other.Path.Substring(5) : other.Path;
                string leftQuery = MeetIdentityQuery(Query), rightQuery = MeetIdentityQuery(other.Query);
                return leftQuery != null && rightQuery != null && leftPath == rightPath && leftQuery == rightQuery;
            }
            return String.Equals(Path, other.Path, StringComparison.Ordinal) &&
                String.Equals(Query, other.Query, StringComparison.Ordinal);
        }

        private static string MeetIdentityQuery(string query)
        {
            if (query.Length == 0) return "";
            var parts = new List<string>();
            bool routingFlag = false;
            foreach (string part in query.Substring(1).Split('&'))
            {
                if (part == "pli=1")
                {
                    if (routingFlag) return null;
                    routingFlag = true;
                }
                else if (part == "pli" || part.StartsWith("pli=", StringComparison.Ordinal)) return null;
                else parts.Add(part);
            }
            return parts.Count == 0 ? "" : "?" + String.Join("&", parts.ToArray());
        }
    }

    internal sealed class WindowIdentity
    {
        internal readonly long Handle;
        internal readonly int Pid;
        internal readonly string ImagePath;
        internal readonly long ProcessStartTicks;

        internal WindowIdentity(long handle, int pid, string imagePath, long processStartTicks)
        {
            Handle = handle; Pid = pid; ImagePath = imagePath; ProcessStartTicks = processStartTicks;
        }

        internal bool SameOwner(WindowIdentity other)
        {
            return other != null && Handle == other.Handle && Pid == other.Pid &&
                ProcessStartTicks == other.ProcessStartTicks &&
                String.Equals(ImagePath, other.ImagePath, StringComparison.OrdinalIgnoreCase);
        }
    }

    internal static class WindowOwnership
    {
        internal static bool SelectUniqueNew(IList<WindowIdentity> before, IList<WindowIdentity> after,
            string expectedImagePath, out WindowIdentity selected)
        {
            selected = null;
            if (before == null || after == null || String.IsNullOrEmpty(expectedImagePath)) return false;
            foreach (WindowIdentity candidate in after)
            {
                if (candidate == null || candidate.Handle <= 0 || candidate.Pid <= 0 ||
                    !String.Equals(candidate.ImagePath, expectedImagePath, StringComparison.OrdinalIgnoreCase)) continue;
                bool existed = false;
                foreach (WindowIdentity old in before) if (old != null && old.Handle == candidate.Handle) { existed = true; break; }
                if (existed) continue;
                if (selected != null) { selected = null; return false; }
                selected = candidate;
            }
            return selected != null;
        }
    }
}
