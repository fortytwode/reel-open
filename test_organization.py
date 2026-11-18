import os
import unittest
from unittest.mock import patch

from reel_organization import (
    firebase_project,
    is_internal_email,
    notes_base_url,
    organization_domain,
    trusted_origins,
)


class OrganizationConfigurationTests(unittest.TestCase):
    def test_another_organization_uses_its_exact_configured_domain(self):
        with patch.dict(os.environ, {"REEL_ORGANIZATION_DOMAIN": "Acme.Example"}, clear=True):
            self.assertEqual(organization_domain(), "acme.example")
            self.assertTrue(is_internal_email("Nina@Acme.Example"))
            for address in ("nina@rocketshiphq.com", "nina@acme.example.evil",
                            "nina@sub.acme.example", "nina@notacme.example",
                            "nina@@acme.example", "nina\r\nBcc: outsider@acme.example"):
                with self.subTest(address=address):
                    self.assertFalse(is_internal_email(address))

    def test_absent_or_invalid_domain_never_grants_membership(self):
        for domain in (None, "", "*", "*.acme.example", "https://acme.example",
                       "owner@acme.example", "acme.example,evil.example", "acme.example:443"):
            with self.subTest(domain=domain), patch.dict(os.environ, {}, clear=True):
                if domain is not None:
                    os.environ["REEL_ORGANIZATION_DOMAIN"] = domain
                self.assertEqual(organization_domain(), "")
                self.assertFalse(is_internal_email("owner@acme.example"))
                self.assertFalse(is_internal_email("owner@rocketshiphq.com"))
                self.assertFalse(is_internal_email("owner@"))

    def test_firebase_project_is_deployment_configuration(self):
        with patch.dict(os.environ, {"REEL_FIREBASE_PROJECT": "reel-acme"}, clear=True):
            self.assertEqual(firebase_project(), "reel-acme")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(firebase_project(), "")

    def test_browser_origins_are_explicit_and_exact(self):
        with patch.dict(os.environ, {"REEL_ALLOWED_ORIGINS":
                "https://reel.acme.example,http://localhost:8080,*,https://*.acme.example,https://bad.example/path"}, clear=True):
            self.assertEqual(trusted_origins(), frozenset({"https://reel.acme.example", "http://localhost:8080"}))
            self.assertNotIn("https://reel.acme.example.evil", trusted_origins())
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(trusted_origins(), frozenset())

    def test_participant_notes_url_is_configured_and_does_not_expose_credentials(self):
        with patch.dict(os.environ, {"REEL_NOTES_BASE_URL": "https://notes.acme.example/reel/"}, clear=True):
            self.assertEqual(notes_base_url(), "https://notes.acme.example/reel")
        for value in ("", "javascript:alert(1)", "https://user:pass@notes.acme.example/reel",
                      "https://notes.acme.example/reel?token=private", "https://notes.acme.example/reel#private",
                      "https://not a host/reel"):
            with self.subTest(value=value), patch.dict(os.environ, {"REEL_NOTES_BASE_URL": value}, clear=True):
                self.assertEqual(notes_base_url(), "")


if __name__ == "__main__":
    unittest.main()
