"""Secrets, fetched from Doppler into memory at run time.

The request carries no credential: the cloud environment's network secret for
api.doppler.com adds the read-only service token after the request leaves the session.
Values live only in Secret objects, which never show their value in repr, str, f-strings,
logs or pickles. Call reveal() at the point of use and nowhere else.
"""

from collections.abc import Iterator, Mapping

import httpx

from finos.errors import SecretsError, proxy_refused

DOPPLER_HOST = "api.doppler.com"


class Secret:
    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "Secret('****')"

    __str__ = __repr__

    def __format__(self, spec: str) -> str:
        return repr(self)

    def __reduce__(self) -> tuple:
        raise TypeError("secrets cannot be pickled")


class Secrets:
    def __init__(self, values: Mapping[str, Secret]) -> None:
        self._values = dict(values)

    def names(self) -> list[str]:
        return sorted(self._values)

    def get(self, name: str) -> Secret:
        try:
            return self._values[name]
        except KeyError:
            raise SecretsError(
                f"Doppler has no secret named {name}. Add it to the finos project's prd config."
            ) from None

    def with_prefix(self, prefix: str) -> Iterator[str]:
        return (name for name in self.names() if name.startswith(prefix))

    def __repr__(self) -> str:
        return f"Secrets(names={self.names()})"

    __str__ = __repr__


def load_secrets(client: httpx.Client, url: str) -> Secrets:
    """Fetch the finos config from Doppler. Error messages never include response bodies."""
    try:
        response = client.get(url)
    except httpx.ProxyError as error:
        raise SecretsError(proxy_refused(DOPPLER_HOST, error)) from None
    except httpx.HTTPError as error:
        raise SecretsError(f"Could not reach {DOPPLER_HOST}: {type(error).__name__}") from None

    if response.status_code in (401, 403):
        raise SecretsError(
            f"Doppler refused the request (HTTP {response.status_code}). Check the cloud "
            f"environment's network secret for {DOPPLER_HOST}: it must hold a read-only "
            "service token for finos/prd, sent as a Bearer token, and it may have expired."
        )
    if response.status_code != 200:
        raise SecretsError(f"Doppler returned HTTP {response.status_code}")

    try:
        payload = response.json()
    except ValueError:
        raise SecretsError("Doppler returned a response that is not JSON") from None
    if not isinstance(payload, dict):
        raise SecretsError("Doppler returned secrets in an unexpected shape")

    values: dict[str, Secret] = {}
    for name, value in payload.items():
        if name.startswith("DOPPLER_"):
            continue  # Doppler's own metadata about the project and config
        if not isinstance(value, str):
            raise SecretsError(f"Doppler secret {name} is not text")
        values[name] = Secret(value)
    return Secrets(values)
