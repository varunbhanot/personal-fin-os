import logging

import httpx
import pytest

from finos.errors import SecretsError
from finos.secrets import Secret, load_secrets

URL = "https://api.doppler.com/v3/configs/config/secrets/download?format=json"
PAYLOAD = {
    "PW_HDFC_TATANEU": "test-pw-hdfc",
    "ANTHROPIC_KEY": "sk-ant-test-value",
    "DOPPLER_PROJECT": "finos",
    "DOPPLER_CONFIG": "prd",
    "DOPPLER_ENVIRONMENT": "prd",
}


def client_returning(response: httpx.Response, seen: list | None = None) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return response

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_loads_secrets_without_sending_a_credential():
    seen: list[httpx.Request] = []

    secrets = load_secrets(client_returning(httpx.Response(200, json=PAYLOAD), seen), URL)

    assert str(seen[0].url) == URL
    assert "authorization" not in seen[0].headers
    assert secrets.names() == ["ANTHROPIC_KEY", "PW_HDFC_TATANEU"]
    assert secrets.get("PW_HDFC_TATANEU").reveal() == "test-pw-hdfc"


def test_values_never_appear_in_repr_str_or_format():
    secrets = load_secrets(client_returning(httpx.Response(200, json=PAYLOAD)), URL)
    secret = secrets.get("ANTHROPIC_KEY")

    for text in (repr(secret), str(secret), f"{secret}", repr(secrets), str(secrets)):
        assert "sk-ant-test-value" not in text
        assert "test-pw-hdfc" not in text


def test_values_never_reach_the_logs(caplog):
    caplog.set_level(logging.DEBUG)

    secrets = load_secrets(client_returning(httpx.Response(200, json=PAYLOAD)), URL)
    logging.getLogger("finos").info("loaded %s", secrets)

    assert "test-pw-hdfc" not in caplog.text
    assert "sk-ant-test-value" not in caplog.text


def test_a_missing_secret_is_named():
    secrets = load_secrets(client_returning(httpx.Response(200, json=PAYLOAD)), URL)

    with pytest.raises(SecretsError, match="PW_SBI_CARD"):
        secrets.get("PW_SBI_CARD")


def test_with_prefix_selects_matching_secrets():
    secrets = load_secrets(client_returning(httpx.Response(200, json=PAYLOAD)), URL)

    assert list(secrets.with_prefix("PW_")) == ["PW_HDFC_TATANEU"]


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_token_points_at_the_network_secret(status):
    response = httpx.Response(status, json={"messages": ["Invalid token test-pw-hdfc"]})

    with pytest.raises(SecretsError) as error:
        load_secrets(client_returning(response), URL)

    assert "network secret" in str(error.value)
    assert "api.doppler.com" in str(error.value)
    assert "test-pw-hdfc" not in str(error.value)


def test_an_unexpected_body_is_rejected_without_echoing_it():
    response = httpx.Response(200, json=["test-pw-hdfc"])

    with pytest.raises(SecretsError) as error:
        load_secrets(client_returning(response), URL)

    assert "test-pw-hdfc" not in str(error.value)


def test_non_text_values_are_rejected():
    response = httpx.Response(200, json={"PW_X": 1234})

    with pytest.raises(SecretsError, match="PW_X"):
        load_secrets(client_returning(response), URL)


def test_a_network_failure_becomes_a_secrets_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    with pytest.raises(SecretsError):
        load_secrets(httpx.Client(transport=httpx.MockTransport(handler)), URL)


def test_a_proxy_refusal_points_at_the_network_secret():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ProxyError("403 Forbidden http://user:proxy-token@proxy")

    with pytest.raises(SecretsError) as error:
        load_secrets(httpx.Client(transport=httpx.MockTransport(handler)), URL)

    assert "api.doppler.com" in str(error.value)
    assert "(proxy status 403)" in str(error.value)
    assert "network secret" in str(error.value)
    assert "proxy-token" not in str(error.value)


def test_secret_rejects_pickling():
    import pickle

    with pytest.raises(TypeError):
        pickle.dumps(Secret("test-pw-hdfc"))
