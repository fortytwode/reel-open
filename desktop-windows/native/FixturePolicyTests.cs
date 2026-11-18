using System;
using ReelNative;

internal static class FixturePolicyTests
{
    public static int Main()
    {
        ProviderUrl fixture, provider;
        if (!ProviderUrl.TryParse("http://127.0.0.1:8443/fixture", out fixture) || fixture.Kind != Provider.Fixture)
            throw new Exception("TEST_FIXTURE build did not accept the dedicated loopback fixture");
        if (ProviderUrl.TryParse("https://localhost:8443/fixture", out fixture))
            throw new Exception("Fixture build accepted an unlisted host");
        if (!ProviderUrl.TryParse("https://meet.google.com/abc-defg-hij", out provider))
            throw new Exception("Fixture build lost provider validation");
        Console.WriteLine("PASS fixture-only URL policy");
        return 0;
    }
}
