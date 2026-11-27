using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace ReelNative
{
    internal static class OutlookCalendar
    {
        private static readonly Regex ProviderLink = new Regex(
            @"https://(?:meet\.google\.com|(?:[\w-]+\.)*zoom\.us|teams\.(?:microsoft|live)\.com)/[^\s<>\""']+",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        // Outlook exposes UTC fields as COM dates with unspecified DateTimeKind.
        private static string Utc(DateTime value)
        {
            return DateTime.SpecifyKind(value, DateTimeKind.Utc).ToString("o");
        }

        internal static int Read()
        {
            try
            {
                string email = Environment.GetEnvironmentVariable("REEL_OUTLOOK_EMAIL");
                if (String.IsNullOrEmpty(email)) return 1;
                dynamic outlook = Marshal.GetActiveObject("Outlook.Application");
                dynamic folder = null;
                foreach (dynamic account in outlook.Session.Accounts)
                {
                    if (!String.Equals((string)account.SmtpAddress, email, StringComparison.OrdinalIgnoreCase)) continue;
                    if (folder != null) return 1;
                    folder = account.DeliveryStore.GetDefaultFolder(9); // olFolderCalendar
                }
                if (folder == null) return 1;
                var events = new List<object>();
                if (Environment.GetEnvironmentVariable("REEL_OUTLOOK_READ_EVENTS") == "1")
                {
                    dynamic items = folder.Items;
                    items.Sort("[Start]");
                    items.IncludeRecurrences = true;
                    DateTime now = DateTime.Now;
                    string from = now.AddDays(-1).ToString("g", CultureInfo.CurrentCulture).Replace("'", "''");
                    string until = now.AddDays(7).AddMinutes(1).ToString("g", CultureInfo.CurrentCulture).Replace("'", "''");
                    dynamic matches = items.Restrict("[Start] >= '" + from + "' AND [Start] < '" + until + "'");
                    int count = 0;
                    foreach (dynamic item in matches)
                    {
                        if (++count > 1000) return 1;
                        if ((int)item.Class != 26 || (int)item.Sensitivity != 0 || (bool)item.AllDayEvent ||
                            ((int)item.MeetingStatus & 4) != 0 || (int)item.ResponseStatus == 4) continue;
                        string location = (string)item.Location ?? "";
                        string body = (string)item.Body ?? "";
                        if (location.Length > 8192 || body.Length > 65536) continue;
                        var links = new HashSet<string>(StringComparer.Ordinal);
                        foreach (Match m in ProviderLink.Matches(location + " " + body))
                            links.Add(m.Value.TrimEnd('.', ',', ';', ')', ']', '}'));
                        if (links.Count != 1) continue;
                        foreach (string url in links)
                            events.Add(new { id = (string)item.EntryID, subject = (string)item.Subject, url = url,
                                             start = Utc((DateTime)item.StartUTC), end = Utc((DateTime)item.EndUTC) });
                    }
                }
                Console.WriteLine(new JavaScriptSerializer().Serialize(new { account = email, events = events }));
                return 0;
            }
            catch { return 1; } // Never print private Outlook data on COM errors.
        }
    }
}
