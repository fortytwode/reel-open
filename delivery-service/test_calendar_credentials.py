"""Delegated Calendar access works without the private deployment adapter."""
import sys
import types
from unittest.mock import Mock, patch

import pytest

from app import DeliveryError, calendar_service


def test_standalone_calendar_uses_operator_credentials_without_private_config(tmp_path, monkeypatch):
    path = tmp_path / 'delegation.json'
    path.write_text('{}')
    monkeypatch.setenv('GOOGLE_CALENDAR_CREDENTIALS', str(path))
    monkeypatch.delenv('REEL_DELIVERY_PROVIDER', raising=False)
    credentials = Mock()
    delegated = credentials.with_subject.return_value
    with patch.dict(sys.modules, {'config': None}), \
            patch('google.oauth2.service_account.Credentials.from_service_account_file', return_value=credentials) as load, \
            patch('googleapiclient.discovery.build', return_value='calendar-service') as build, \
            patch('google_auth_httplib2.AuthorizedHttp') as authorized:
        assert calendar_service('owner@northwind.example') == 'calendar-service'
        load.assert_called_once_with(str(path), scopes=['https://www.googleapis.com/auth/calendar.readonly'])
        credentials.with_subject.assert_called_once_with('owner@northwind.example')
        assert authorized.call_args.args[0] is delegated
        assert build.call_args.kwargs['cache_discovery'] is False


def test_standalone_missing_credentials_fail_closed_without_private_config(monkeypatch):
    monkeypatch.delenv('GOOGLE_CALENDAR_CREDENTIALS', raising=False)
    monkeypatch.delenv('REEL_DELIVERY_PROVIDER', raising=False)
    with patch.dict(sys.modules, {'config': None}), pytest.raises(DeliveryError, match='credentials'):
        calendar_service('owner@northwind.example')


def test_explicit_private_adapter_keeps_existing_calendar_configuration(tmp_path, monkeypatch):
    path = tmp_path / 'existing-delegation.json'
    path.write_text('{}')
    monkeypatch.delenv('GOOGLE_CALENDAR_CREDENTIALS', raising=False)
    monkeypatch.setenv('REEL_DELIVERY_PROVIDER', 'canonical')
    config = types.ModuleType('config')
    config.SERVICE_ACCOUNT_PATHS = [path]
    with patch.dict(sys.modules, {'config': config}), \
            patch('google.oauth2.service_account.Credentials.from_service_account_file'), \
            patch('googleapiclient.discovery.build', return_value='existing-calendar'):
        assert calendar_service('owner@northwind.example') == 'existing-calendar'
