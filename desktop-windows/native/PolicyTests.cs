using System;
using System.Collections.Generic;
using ReelNative;

internal static class PolicyTests
{
    private static int checks;

    private static void Check(bool value, string name)
    {
        checks++;
        if (!value) throw new Exception("FAIL " + name);
    }

    private static void Accept(string url, Provider provider)
    {
        ProviderUrl parsed;
        Check(ProviderUrl.TryParse(url, out parsed) && parsed.Kind == provider, "accept " + provider);
    }

    private static void Reject(string url)
    {
        ProviderUrl parsed;
        Check(!ProviderUrl.TryParse(url, out parsed), "reject unsafe URL");
    }

    private static void RejectGoogleSignIn(string url)
    {
        GoogleSignInUrl parsed;
        Check(!GoogleSignInUrl.TryParse(url, out parsed), "reject unsafe Google sign-in URL");
    }

    public static int Main()
    {
        Accept("https://meet.google.com/abc-defg-hij", Provider.GoogleMeet);
        Accept("https://meet.google.com:443/abc-defg-hij", Provider.GoogleMeet);
        Accept("https://zoom.us/j/123456789?pwd=Secret", Provider.Zoom);
        Accept("https://us06web.zoom.us/wc/12345678901/join", Provider.Zoom);
        Accept("https://teams.microsoft.com/l/meetup-join/token/123", Provider.Teams);
        Accept("https://teams.live.com/meet/123", Provider.Teams);
        Reject("http://meet.google.com/abc-defg-hij");
        Reject("https://meet.google.com.evil.test/abc-defg-hij");
        Reject("https://meet.google.com:8443/abc-defg-hij");
        Reject("https://user@meet.google.com/abc-defg-hij");
        Reject("https://meet.google.com/abc-defg-hij#fragment");
        Reject("https://meet.google.com/abc-defg-hij/../abc-defg-hij");
        Reject("https://127.0.0.1:8080/abc-defg-hij");
        Reject("https://meet.teams.microsoft.com/meet/123");
        Reject("https://meet.google.com/abc-defg-hij\\evil");
        Reject("https://zoom.us/j/123456789?pwd=\" --guest");

        GoogleSignInUrl signIn;
        Check(GoogleSignInUrl.TryParse("https://accounts.google.com/o/oauth2/v2/auth?state=abc&scope=openid+email&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Foauthredirect", out signIn), "accept generated Google OAuth endpoint");
        Check(GoogleSignInUrl.TryParse("https://accounts.google.com:443/o/oauth2/v2/auth", out signIn), "accept OAuth HTTPS default port");
        RejectGoogleSignIn(null);
        RejectGoogleSignIn("");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth?x=" + new string('a', 4096));
        RejectGoogleSignIn("http://accounts.google.com/o/oauth2/v2/auth");
        RejectGoogleSignIn("https://accounts.google.com.evil.test/o/oauth2/v2/auth");
        RejectGoogleSignIn("https://accounts.google.com./o/oauth2/v2/auth");
        RejectGoogleSignIn("https://accounts.google.com:8443/o/oauth2/v2/auth");
        RejectGoogleSignIn("https://user@accounts.google.com/o/oauth2/v2/auth");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth#");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth#fragment");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth/");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/../v2/auth");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/%61uth");
        RejectGoogleSignIn("https://accounts.google.com/O/oauth2/v2/auth");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth?x=\"--guest");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth?x='");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth?x=\\");
        RejectGoogleSignIn(" https://accounts.google.com/o/oauth2/v2/auth");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth?x=\n");
        RejectGoogleSignIn("https://accounts.google.com/o/oauth2/v2/auth?x=\u0085");

        ProviderUrl a, b;
        Check(ProviderUrl.TryParse("https://zoom.us/j/123456789?pwd=A", out a), "parse first passcode");
        Check(ProviderUrl.TryParse("https://zoom.us/j/123456789?pwd=B", out b), "parse second passcode");
        Check(!a.SameAddress(b), "passcode mismatch");
        Check(a.SameAddress(a), "same address");

        ProviderUrl.TryParse("https://meet.google.com/abc-defg-hij", out a);
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?pli=1", out b);
        Check(a.SameAddress(b) && b.SameAddress(a), "Google same-call routing redirect");
        ProviderUrl.TryParse("https://meet.google.com/meet/xyz-defg-hij?pli=1", out b);
        Check(!a.SameAddress(b), "Google different meeting rejected");
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?pli=1&pli=1", out b);
        Check(!a.SameAddress(b), "duplicate routing flag rejected");
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?pli=2", out b);
        Check(!a.SameAddress(b), "unknown routing value retained");
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?authuser=1&pli=1", out b);
        Check(!a.SameAddress(b), "account routing change rejected");
        ProviderUrl.TryParse("https://meet.google.com/abc-defg-hij?authuser=0", out a);
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?authuser=0&pli=1", out b);
        Check(a.SameAddress(b), "matching account routing retained");
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?authuser=0&unexpected=1&pli=1", out b);
        Check(!a.SameAddress(b), "unknown query change rejected");
        ProviderUrl.TryParse("https://meet.google.com/abc-defg-hij?x=1&y=2", out a);
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?x=1&pli=1&y=2", out b);
        Check(a.SameAddress(b), "routing flag removed without reordering query");
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?y=2&x=1&pli=1", out b);
        Check(!a.SameAddress(b), "unknown query order preserved");
        ProviderUrl.TryParse("https://meet.google.com/abc-defg-hij", out a);
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij", out b);
        Check(a.SameAddress(b), "Google path alias without query");
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?pli", out b);
        Check(!a.SameAddress(b), "bare routing flag rejected");
        ProviderUrl.TryParse("https://meet.google.com/meet/abc-defg-hij?pli=1&pli=2", out b);
        Check(!a.SameAddress(b), "conflicting routing flags rejected");

        var before = new List<WindowIdentity> { new WindowIdentity(11, 1, "C:\\Chrome\\chrome.exe", 1) };
        var after = new List<WindowIdentity> { before[0], new WindowIdentity(12, 9, "C:\\Chrome\\chrome.exe", 2) };
        WindowIdentity selected;
        Check(WindowOwnership.SelectUniqueNew(before, after, "C:\\Chrome\\chrome.exe", out selected) && selected.Handle == 12, "one new owned window");
        after.Add(new WindowIdentity(13, 9, "C:\\Chrome\\chrome.exe", 2));
        Check(!WindowOwnership.SelectUniqueNew(before, after, "C:\\Chrome\\chrome.exe", out selected), "ambiguous new windows");
        Check(!WindowOwnership.SelectUniqueNew(before, before, "C:\\Chrome\\chrome.exe", out selected), "no new window");
        after = new List<WindowIdentity> { before[0], new WindowIdentity(12, 9, "C:\\Other\\chrome.exe", 2) };
        Check(!WindowOwnership.SelectUniqueNew(before, after, "C:\\Chrome\\chrome.exe", out selected), "wrong Chrome binary");
        after = new List<WindowIdentity> { new WindowIdentity(11, 9, "C:\\Chrome\\chrome.exe", 2) };
        Check(!WindowOwnership.SelectUniqueNew(before, after, "C:\\Chrome\\chrome.exe", out selected), "recycled HWND rejected");
        Console.WriteLine("PASS " + checks + " pure policy checks");
        return 0;
    }
}
