import os
import sys
import types
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from app import ProviderPending
from providers import configured_providers


CONFIG = {
    'REEL_ORGANIZATION_DOMAIN': 'acme.example',
    'REEL_RECAP_SENDER': 'notes@acme.example',
    'REEL_NOTION_DATA_SOURCE_ID': '12345678-1234-1234-1234-123456789abc',
    'NOTION_TOKEN': 'test-only',
    'REEL_NOTES_BASE_URL': 'https://notes.acme.example/library',
    'GOOGLE_CALENDAR_CREDENTIALS': '/test-only/credentials.json',
}


def test_default_delivery_runs_without_the_private_distribution_module():
    with patch.dict(os.environ, CONFIG, clear=True), \
            patch.dict(sys.modules, {'distribution': None}), \
            patch('standalone_providers._gmail_service', return_value=object()):
        provider = configured_providers(store=object())
        assert provider.choose_route('Planning', ['owner@acme.example'], True) == {'kind': 'private'}
        assert provider.message_id('meeting-1').endswith('@acme.example')


def test_private_adapter_is_selected_only_by_explicit_operator_configuration():
    adapter = types.ModuleType('distribution')
    with patch.dict(os.environ, {'REEL_DELIVERY_PROVIDER': 'canonical'}, clear=True), \
            patch.dict(sys.modules, {'distribution': adapter}), \
            patch('providers.install_bounded_transports'):
        assert configured_providers().canonical is adapter


def test_unknown_provider_configuration_never_silently_selects_an_adapter():
    with patch.dict(os.environ, {'REEL_DELIVERY_PROVIDER': 'misspelled'}, clear=True):
        with pytest.raises(ProviderPending, match='provider'):
            configured_providers()


def test_canonical_delegates_gmail_to_recap_sender_only():
    adapter = types.ModuleType('distribution')
    adapter.CALENDAR_EMAIL = 'admin@acme.example'
    credentials = Mock()
    transport = Mock()
    transport.credentials = credentials
    service = types.SimpleNamespace(_http=transport)
    adapter.get_gmail_service = Mock(return_value=service)
    with patch.dict(os.environ, {**CONFIG, 'REEL_DELIVERY_PROVIDER': 'canonical'}, clear=True), \
            patch.dict(sys.modules, {'distribution': adapter}), \
            patch('providers.install_bounded_transports'), patch('providers.GmailHttp') as gmail_transport:
        provider = configured_providers()
        assert provider._gmail() is service
        credentials.with_subject.assert_called_once_with(CONFIG['REEL_RECAP_SENDER'])
        gmail_transport.assert_called_once_with(credentials.with_subject.return_value)
        assert adapter.CALENDAR_EMAIL == 'admin@acme.example'
