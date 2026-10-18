import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from finos.errors import ConfigError, DriveError
from finos.inbox import service_account_auth
from finos.secrets import Secret


def service_account_key() -> Secret:
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    info = {
        "type": "service_account",
        "project_id": "finos-test",
        "private_key_id": "abc",
        "private_key": pem,
        "client_email": "finos@finos-test.iam.gserviceaccount.com",
        "client_id": "1",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    return Secret(json.dumps(info))


def test_headers_carry_a_refreshed_token(monkeypatch):
    from google.oauth2 import service_account

    def fake_refresh(self, request):
        self.token = "ya29.token"
        self.expiry = None

    monkeypatch.setattr(service_account.Credentials, "refresh", fake_refresh)

    headers = service_account_auth(service_account_key())

    assert headers() == {"Authorization": "Bearer ya29.token"}


def test_a_refused_key_becomes_a_drive_error(monkeypatch):
    import google.auth.exceptions
    from google.oauth2 import service_account

    def refuse(self, request):
        raise google.auth.exceptions.RefreshError("invalid_grant")

    monkeypatch.setattr(service_account.Credentials, "refresh", refuse)

    headers = service_account_auth(service_account_key())

    with pytest.raises(DriveError, match="GDRIVE_SA_JSON"):
        headers()


@pytest.mark.parametrize("value", ["not json at all", json.dumps({"type": "service_account"})])
def test_a_malformed_key_is_rejected_without_echoing_it(value):
    with pytest.raises(ConfigError) as error:
        service_account_auth(Secret(value))

    assert "GDRIVE_SA_JSON" in str(error.value)
    assert value not in str(error.value)
